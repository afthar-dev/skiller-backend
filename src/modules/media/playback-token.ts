import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Playback token: `base64url(JSON claims) "." base64url(HMAC-SHA256(secret, payloadPart))`.
 * The Cloudflare playback gate (edge/playback-gate) implements the same algorithm with WebCrypto; both are tested
 * against edge/playback-gate/test/vectors.json.
 */
export interface PlaybackClaims {
  /** viewer user id */
  u: string;
  /** media asset id the token is valid for */
  a: string;
  /** expiry, unix seconds */
  exp: number;
}

export const PLAYBACK_TOKEN_TTL_SEC = 10 * 60;
export const MAX_TOKEN_LENGTH = 512;

const B64URL = /^[A-Za-z0-9_-]+$/;

const mac = (payloadPart: string, secret: string) => createHmac("sha256", secret).update(payloadPart).digest();

export function signPlaybackToken(claims: PlaybackClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ u: claims.u, a: claims.a, exp: claims.exp })).toString("base64url");
  return `${payload}.${mac(payload, secret).toString("base64url")}`;
}

/** Returns the claims, or null for anything malformed, tampered with or expired (`exp` must be after `nowSec`). */
export function verifyPlaybackToken(token: string, secret: string, nowSec: number): PlaybackClaims | null {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!B64URL.test(payload) || !B64URL.test(signature)) return null;

  const given = Buffer.from(signature, "base64url");
  const expected = mac(payload, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const { u, a, exp } = claims as Record<string, unknown>;
  if (typeof u !== "string" || typeof a !== "string" || typeof exp !== "number" || !Number.isFinite(exp)) return null;
  if (exp <= nowSec) return null;
  return { u, a, exp };
}
