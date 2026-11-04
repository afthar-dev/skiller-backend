import type { AppConfig } from "../../common/config/config.schema";
import { CatalogCursor, validKey, type CursorPayload } from "./catalog-cursor";

const codec = (secret = "s".repeat(40)) => new CatalogCursor({ jwtSecret: secret } as AppConfig);
const payload: CursorPayload = { v: 1, s: "popular", m: "none", h: "abcdefabcdef", k: ["5", "50"], id: "0192f3a0-0000-7000-8000-000000000001" };

describe("catalog cursor", () => {
  it("round-trips what this server signed", () => {
    const c = codec();
    expect(c.verify(c.sign(payload))).toEqual(payload);
  });

  it("rejects a cursor signed with another key, a tampered body and an unsigned one", () => {
    const signed = codec().sign(payload);
    expect(() => codec("t".repeat(40)).verify(signed)).toThrow(expect.objectContaining({ code: "BAD_CURSOR", status: 400 }));
    const [body, sig] = signed.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, k: ["9999999999", "1"] })).toString("base64url");
    expect(() => codec().verify(`${forged}.${sig}`)).toThrow(expect.objectContaining({ code: "BAD_CURSOR" }));
    expect(() => codec().verify(body)).toThrow(expect.objectContaining({ code: "BAD_CURSOR" }));
    expect(() => codec().verify(`${body}.${sig}.x`)).toThrow(expect.objectContaining({ code: "BAD_CURSOR" }));
    expect(() => codec().verify("")).toThrow(expect.objectContaining({ code: "BAD_CURSOR" }));
  });

  it("rejects a signed payload that is not shaped like a cursor", () => {
    const c = codec();
    expect(() => c.verify(c.sign({ ...payload, m: "other" } as never))).toThrow(expect.objectContaining({ code: "BAD_CURSOR" }));
    expect(() => c.verify(c.sign({ ...payload, id: "not-an-id" }))).toThrow(expect.objectContaining({ code: "BAD_CURSOR" }));
  });

  it("range-checks every key type", () => {
    expect(validKey("2147483647", "int")).toBe(true);
    expect(validKey("2147483648", "int")).toBe(false);
    expect(validKey("9999999999", "int")).toBe(false);
    expect(validKey("-1", "int")).toBe(false);
    expect(validKey("4.33", "numeric")).toBe(true);
    expect(validKey("1234567", "numeric")).toBe(false);
    expect(validKey("2026-11-04 10:00:00.123", "timestamp")).toBe(true);
    expect(validKey("2026-11-04 10:00:00", "timestamp")).toBe(true);
    expect(validKey("9999-99-99 99:99:99", "timestamp")).toBe(false);
    expect(validKey("2026-02-30 10:00:00", "timestamp")).toBe(false);
    expect(validKey("2026-11-04 25:00:00", "timestamp")).toBe(false);
    expect(validKey("9999-12-31 23:59:59", "timestamp")).toBe(false);
    expect(validKey("1970-01-01 00:00:00", "timestamp")).toBe(false);
  });
});
