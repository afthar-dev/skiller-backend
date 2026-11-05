import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../common/redis/redis.constants";
import { MAX_STREAMS_PER_USER, streamChannel } from "./messaging-rules";

export const MESSAGE_STREAM_OPTIONS = "MESSAGE_STREAM_OPTIONS";
export interface MessageStreamOptions {
  /** How often an open stream sends a comment line (and re-checks its token and session). 25 s in production. */
  heartbeatMs: number;
}
export const DEFAULT_STREAM_OPTIONS: MessageStreamOptions = { heartbeatMs: 25_000 };

/** What goes over the wire: an SSE event name and its JSON data. */
export interface StreamEvent {
  event: string;
  data: unknown;
}

type Listener = (payload: string) => void;

/**
 * Live delivery through Redis pub/sub: one channel per user, so any API instance can serve any client's stream. One subscriber connection per
 * process, shared by all of its streams (subscribed to a user's channel while that user has a stream here). Delivery is best effort; every message is
 * also in the database, and the polling endpoints return the same data without this.
 */
@Injectable()
export class MessageStreamHub implements OnModuleDestroy {
  private readonly logger = new Logger(MessageStreamHub.name);
  private subscriber: Redis | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  /** Channel subscriptions in flight: a second stream of the same user waits for the first one's SUBSCRIBE too. */
  private readonly subscribing = new Map<string, Promise<unknown>>();
  /** Ends the streams a user holds here, oldest first. */
  private readonly open = new Map<string, Array<() => void>>();

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Sends an event to every stream the user has, on any instance. Never throws: a failed push is a delayed message, not a failed send. */
  async publish(userId: string, event: StreamEvent): Promise<void> {
    try {
      await this.redis.publish(streamChannel(userId), JSON.stringify(event));
    } catch (err) {
      this.logger.warn(`could not push to user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Resolves once the subscription is live (events published afterwards are delivered). Returns the function that ends it. */
  async subscribe(userId: string, listener: Listener): Promise<() => void> {
    const channel = streamChannel(userId);
    const sub = this.subscriberConnection();
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      const pending = sub.subscribe(channel).finally(() => this.subscribing.delete(channel));
      this.subscribing.set(channel, pending);
    }
    set.add(listener);
    try {
      await this.subscribing.get(channel);
    } catch (err) {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(channel);
      throw err;
    }
    return () => {
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(channel);
        sub.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  /** Remembers how to end a user's stream; past MAX_STREAMS_PER_USER the oldest is ended. Returns the function that forgets it. */
  track(userId: string, end: () => void): () => void {
    const list = this.open.get(userId) ?? [];
    list.push(end);
    this.open.set(userId, list);
    while (list.length > MAX_STREAMS_PER_USER) list.shift()?.();
    return () => {
      const current = this.open.get(userId);
      if (!current) return;
      const i = current.indexOf(end);
      if (i >= 0) current.splice(i, 1);
      if (current.length === 0) this.open.delete(userId);
    };
  }

  /** Shutdown: end every stream so the HTTP server can close, then drop the subscriber connection. */
  async onModuleDestroy(): Promise<void> {
    for (const ends of [...this.open.values()]) for (const end of [...ends]) end();
    this.open.clear();
    this.listeners.clear();
    const sub = this.subscriber;
    this.subscriber = null;
    if (sub) await sub.quit().catch(() => undefined);
  }

  private subscriberConnection(): Redis {
    if (this.subscriber) return this.subscriber;
    const sub = this.redis.duplicate();
    sub.on("message", (channel: string, payload: string) => {
      for (const listener of this.listeners.get(channel) ?? []) {
        try {
          listener(payload);
        } catch (err) {
          this.logger.warn(`a stream listener failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
    sub.on("error", (err: Error) => this.logger.warn(`message stream subscriber: ${err.message}`));
    this.subscriber = sub;
    return sub;
  }
}
