import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../common/redis/redis.constants";
import { NotificationsService } from "../notifications";
import { ProfilesService } from "../users";
import { MESSAGE_NOTIFY_WINDOW_SEC } from "./messaging-rules";

/**
 * Tells a person about new messages. Batched: a Redis key per (conversation, recipient) lets one notification through per window however many messages
 * arrive. The notification never carries the message text (a message can be hidden or removed later; the text belongs to the conversation).
 * Best effort: a failed notification never undoes a send.
 */
@Injectable()
export class MessagingNotifier {
  private readonly logger = new Logger(MessagingNotifier.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly profiles: ProfilesService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async newMessage(recipientId: string, senderId: string, conversationId: string): Promise<void> {
    const key = `notify:message:${conversationId}:${recipientId}`;
    try {
      if ((await this.redis.set(key, "1", "EX", MESSAGE_NOTIFY_WINDOW_SEC, "NX")) !== "OK") return;
      try {
        const name = await this.profiles.displayNameOf(senderId);
        await this.notifications.notify(recipientId, {
          type: "message.new",
          title: `New message from ${name}`,
          body: "Open the conversation to read it.",
          link: `/messages/${conversationId}`,
          data: { conversationId, senderId },
        });
      } catch (err) {
        await this.redis.del(key).catch(() => undefined); // not told: let the next message try again
        throw err;
      }
    } catch (err) {
      this.logger.error(`could not notify user ${recipientId} of a new message: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
