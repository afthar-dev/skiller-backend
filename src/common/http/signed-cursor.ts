import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors/app-error";

export const BAD_CURSOR = "BAD_CURSOR";
export const badCursor = () => new AppError(BAD_CURSOR, 400, "The cursor is not valid for this request");

export type CursorValue = string | number;
export type CursorPayload = Record<string, CursorValue>;

const MAX_BODY = 1024;

/**
 * Opaque, signed keyset cursors: base64url(JSON) "." base64url(HMAC-SHA256). The key is derived from the server secret (HKDF) together with a
 * context string, so a cursor made for one list is refused by every other list, and a client can neither forge a cursor nor steer a keyset predicate.
 */
export class SignedCursor {
  private readonly keys = new Map<string, Buffer>();

  constructor(private readonly secret: string) {}

  sign(context: string, payload: CursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${this.mac(context, body)}`;
  }

  /** The payload of a cursor this server signed for `context`; anything else (unsigned, tampered, other list, malformed) is a 400 BAD_CURSOR. */
  verify(context: string, raw: string): CursorPayload {
    const [body, signature, extra] = raw.split(".");
    if (!body || !signature || extra !== undefined || body.length > MAX_BODY) throw badCursor();
    const expected = Buffer.from(this.mac(context, body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw badCursor();
    try {
      const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw badCursor();
      for (const value of Object.values(parsed)) if (typeof value !== "string" && typeof value !== "number") throw badCursor();
      return parsed as CursorPayload;
    } catch {
      throw badCursor();
    }
  }

  private mac(context: string, body: string): string {
    let key = this.keys.get(context);
    if (!key) {
      key = Buffer.from(hkdfSync("sha256", this.secret, "", `cursor:${context}`, 32));
      this.keys.set(context, key);
    }
    return createHmac("sha256", key).update(body).digest("base64url");
  }
}
