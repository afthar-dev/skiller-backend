import { Inject, Injectable } from "@nestjs/common";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { AppError } from "../../common/errors/app-error";

export const CATALOG_SORTS = ["relevance", "newest", "rating", "popular"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];
/** How the text query matches: `fts` when the full-text query matches something, `trgm` (fuzzy title) when it does not, `none` without a text query. */
export type CatalogMode = "fts" | "trgm" | "none";
export type KeyCast = "timestamp" | "int" | "numeric";

export const BAD_CURSOR = "BAD_CURSOR";
export const badCursor = () => new AppError(BAD_CURSOR, 400, "The cursor is not valid for this request");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INT_MAX = 2_147_483_647;
const MIN_YEAR = 2000;
const MAX_YEAR = 2200;

/** Strict range check of one cursor key. A value that passes is safe to cast in SQL. */
export function validKey(value: string, cast: KeyCast): boolean {
  if (cast === "int") return /^\d{1,10}$/.test(value) && Number(value) <= INT_MAX;
  if (cast === "numeric") return /^\d{1,6}(\.\d{1,6})?$/.test(value);
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?$/.exec(value);
  if (!m) return false;
  const time = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`);
  // Date.parse accepts only real dates; the round trip rejects 02-30 style values it would otherwise roll over.
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`) && Number(m[1]) >= MIN_YEAR && Number(m[1]) <= MAX_YEAR;
}

const payloadSchema = z
  .object({ v: z.literal(1), s: z.enum(CATALOG_SORTS), m: z.enum(["fts", "trgm", "none"]), h: z.string().length(12), k: z.array(z.string().max(40)).min(1).max(2), id: z.string().regex(UUID) })
  .strict();
export type CursorPayload = z.infer<typeof payloadSchema>;

/**
 * Catalog cursors are opaque and signed: base64url(JSON) "." base64url(HMAC-SHA256). The key is derived from JWT_SECRET (HKDF, context
 * "catalog-cursor"), so only this server can make one, and a client cannot steer the keyset predicate or the matching mode.
 */
@Injectable()
export class CatalogCursor {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = Buffer.from(hkdfSync("sha256", config.jwtSecret, "", "catalog-cursor", 32));
  }

  sign(payload: CursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${this.mac(body)}`;
  }

  /** The payload of a cursor this server signed; anything else (unsigned, tampered, malformed) is a 400 BAD_CURSOR. */
  verify(raw: string): CursorPayload {
    const [body, signature, extra] = raw.split(".");
    if (!body || !signature || extra !== undefined) throw badCursor();
    const expected = Buffer.from(this.mac(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw badCursor();
    try {
      return payloadSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    } catch {
      throw badCursor();
    }
  }

  private mac(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }
}
