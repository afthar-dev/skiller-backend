// Same token format as src/modules/media/playback-token.ts in the API (shared vectors: test/vectors.json):
//   base64url(JSON {u, a, exp}) "." base64url(HMAC-SHA256(secret, payloadPart))

export interface PlaybackClaims {
  u: string;
  a: string;
  exp: number;
}

export const MAX_TOKEN_LENGTH = 512;
const B64URL = /^[A-Za-z0-9_-]+$/;

function decodeBase64Url(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Claims for a well-signed, unexpired token, else null. The signature check is `crypto.subtle.verify` (constant time). */
export async function verifyPlaybackToken(token: string, secret: string, nowSec: number): Promise<PlaybackClaims | null> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!B64URL.test(payload) || !B64URL.test(signature)) return null;

  let signatureBytes: Uint8Array;
  let payloadBytes: Uint8Array;
  try {
    signatureBytes = decodeBase64Url(signature);
    payloadBytes = decodeBase64Url(payload);
  } catch {
    return null;
  }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("HMAC", key, signatureBytes, new TextEncoder().encode(payload)))) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const { u, a, exp } = claims as Record<string, unknown>;
  if (typeof u !== "string" || typeof a !== "string" || typeof exp !== "number" || !Number.isFinite(exp)) return null;
  if (exp <= nowSec) return null;
  return { u, a, exp };
}
