import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { consumeRateLimit } from "../../common/redis/rate-limiter";
import { REDIS } from "../../common/redis/redis.constants";
import { PromoPreferences } from "../notifications";
import { UnsubscribeTokens } from "./unsubscribe-token";

/** Opening a link (a person, or a scanner following it) per link per minute. */
const VIEWS_PER_TOKEN = 30;
/** Unsubscribes per link per minute: a mailbox provider retries, nobody needs ten. */
const APPLIES_PER_TOKEN = 10;
/** Damaged or forged links per client address per minute. */
const INVALID_PER_IP = 20;

/**
 * Unsubscribing from promotional email. The answers carry no address and no member id: the link is the only thing the caller proves.
 * Limits follow the credential. A link we signed is limited per link, never per address (mailbox providers send a campaign's one-click requests from a
 * handful of addresses); a link we did not sign is a guess, limited per address.
 */
@Injectable()
export class UnsubscribeService {
  constructor(
    private readonly tokens: UnsubscribeTokens,
    private readonly preferences: PromoPreferences,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** The member behind a signed link (400 UNSUBSCRIBE_TOKEN_INVALID for anything else), after the limit that fits the kind of request. */
  async open(token: unknown, ip: string, action: "view" | "apply"): Promise<{ userId: string }> {
    let userId: string;
    try {
      ({ userId } = this.tokens.verify(token));
    } catch (err) {
      await consumeRateLimit(this.redis, `unsubscribe:invalid:${ip}`, INVALID_PER_IP, 60);
      throw err;
    }
    await consumeRateLimit(this.redis, `unsubscribe:${action}:${userId}`, action === "view" ? VIEWS_PER_TOKEN : APPLIES_PER_TOKEN, 60);
    return { userId };
  }

  /**
   * Turns the member's promo preference off and puts their address on the suppression list (reason `unsubscribed`; a bounce already there is kept), so
   * every promotional path honours it, preference row or not.
   */
  async apply(userId: string): Promise<{ unsubscribed: true; category: "promotional" }> {
    await this.preferences.setPromoEmail(userId, false);
    return { unsubscribed: true, category: "promotional" };
  }
}
