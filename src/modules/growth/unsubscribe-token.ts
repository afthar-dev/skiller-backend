import { Inject, Injectable } from "@nestjs/common";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { AppError } from "../../common/errors/app-error";

export const UNSUBSCRIBE_CATEGORIES = ["promotional"] as const;
export type UnsubscribeCategory = (typeof UNSUBSCRIBE_CATEGORIES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const unsubscribeTokenInvalid = () => new AppError("UNSUBSCRIBE_TOKEN_INVALID", 400, "This unsubscribe link is not valid");

/**
 * Unsubscribe links: `base64url("<userId>:<category>") "." base64url(HMAC-SHA256)`. The key is derived from JWT_SECRET (HKDF, context "unsubscribe"), so only
 * this server can make one and a link for one member or category cannot be turned into another. No expiry: an old mail's link keeps working. The link names
 * the member by opaque id only; no address appears in it or in any answer.
 */
@Injectable()
export class UnsubscribeTokens {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.key = Buffer.from(hkdfSync("sha256", config.jwtSecret, "", "unsubscribe", 32));
  }

  sign(userId: string, category: UnsubscribeCategory = "promotional"): string {
    const body = Buffer.from(`${userId}:${category}`).toString("base64url");
    return `${body}.${this.mac(body)}`;
  }

  /** The one-click URL for a member (the API route; List-Unsubscribe-Post targets it). */
  urlFor(userId: string): string {
    return `${this.config.apiBaseUrl}/v1/unsubscribe?t=${this.sign(userId)}`;
  }

  /** The member and category of a link this server signed; anything else (forged, tampered, truncated, wrong shape) is a 400. */
  verify(raw: unknown): { userId: string; category: UnsubscribeCategory } {
    if (typeof raw !== "string" || raw.length > 512) throw unsubscribeTokenInvalid();
    const [body, signature, extra] = raw.split(".");
    if (!body || !signature || extra !== undefined) throw unsubscribeTokenInvalid();
    const expected = Buffer.from(this.mac(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw unsubscribeTokenInvalid();
    const [userId, category, more] = Buffer.from(body, "base64url").toString("utf8").split(":");
    if (more !== undefined || !userId || !UUID.test(userId) || !(UNSUBSCRIBE_CATEGORIES as readonly string[]).includes(category)) throw unsubscribeTokenInvalid();
    return { userId, category: category as UnsubscribeCategory };
  }

  private mac(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }
}
