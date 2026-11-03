import vectors from "../../../edge/playback-gate/test/vectors.json";
import { MAX_TOKEN_LENGTH, signPlaybackToken, verifyPlaybackToken } from "./playback-token";

describe("playback token", () => {
  const { secret, nowSec } = vectors;

  it("signs byte-for-byte what the shared vectors say", () => {
    for (const v of vectors.valid) expect(signPlaybackToken(v.claims, secret)).toBe(v.token);
  });

  it("round-trips", () => {
    const claims = { u: "user-1", a: "asset-1", exp: nowSec + 600 };
    expect(verifyPlaybackToken(signPlaybackToken(claims, secret), secret, nowSec)).toEqual(claims);
  });

  it.each(vectors.valid.map((v) => [v.name, v] as const))("verifies vector: %s", (_n, v) => {
    expect(verifyPlaybackToken(v.token, secret, nowSec)).toEqual(v.claims);
  });

  it.each(vectors.invalid.map((v) => [v.name, v.token] as const))("rejects vector: %s", (_n, token) => {
    expect(verifyPlaybackToken(token, secret, nowSec)).toBeNull();
  });

  it("rejects a token under a different secret", () => {
    const token = signPlaybackToken({ u: "u", a: "a", exp: nowSec + 60 }, secret);
    expect(verifyPlaybackToken(token, "x".repeat(40), nowSec)).toBeNull();
  });

  it("caps token length", () => {
    expect(MAX_TOKEN_LENGTH).toBe(512);
  });
});
