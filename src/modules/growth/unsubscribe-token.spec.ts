import { randomUUID } from "node:crypto";
import type { AppConfig } from "../../common/config/config.schema";
import { segmentSchema } from "./segment";
import { UnsubscribeTokens } from "./unsubscribe-token";

const config = (secret: string) => ({ jwtSecret: secret, apiBaseUrl: "https://api.skiller.test" }) as unknown as AppConfig;
const tokens = new UnsubscribeTokens(config("a".repeat(40)));

describe("UnsubscribeTokens", () => {
  it("round-trips a member and a category", () => {
    const id = randomUUID();
    expect(tokens.verify(tokens.sign(id))).toEqual({ userId: id, category: "promotional" });
  });

  it("builds the one-click URL on the API base", () => {
    const id = randomUUID();
    const url = new URL(tokens.urlFor(id));
    expect(`${url.origin}${url.pathname}`).toBe("https://api.skiller.test/v1/unsubscribe");
    expect(tokens.verify(url.searchParams.get("t")).userId).toBe(id);
  });

  it("refuses tokens signed with another secret, edited bodies, wrong shapes and non-strings", () => {
    const id = randomUUID();
    const token = tokens.sign(id);
    const [body, sig] = token.split(".");
    const other = Buffer.from(`${randomUUID()}:promotional`).toString("base64url");
    const category = Buffer.from(`${id}:marketing`).toString("base64url");
    const foreign = new UnsubscribeTokens(config("b".repeat(40))).sign(id);
    for (const bad of [foreign, `${other}.${sig}`, `${category}.${sig}`, `${body}.${sig.slice(1)}`, `${token}.x`, body, "", ".", undefined, 42, { t: token }]) {
      expect(() => tokens.verify(bad)).toThrow(expect.objectContaining({ code: "UNSUBSCRIBE_TOKEN_INVALID", status: 400 }));
    }
  });

  it("a token carries no address", () => {
    const token = tokens.sign(randomUUID());
    expect(Buffer.from(token.split(".")[0], "base64url").toString()).not.toContain("@");
  });
});

describe("segmentSchema", () => {
  it("accepts every criterion and the empty segment", () => {
    expect(segmentSchema.parse({})).toEqual({});
    const all = { roles: ["creator"], plan: ["pro"], interests: ["tag:python"], lastActive: { inactiveDays: 30 }, hasPurchased: false };
    expect(segmentSchema.parse(all)).toEqual(all);
  });

  it("rejects unknown keys, empty or oversized lists, and malformed lastActive", () => {
    for (const bad of [{ other: 1 }, { roles: [] }, { roles: Array.from({ length: 21 }, () => "x") }, { lastActive: {} }, { lastActive: { withinDays: 5, inactiveDays: 5 } }, { lastActive: { withinDays: 0 } }, { hasPurchased: "yes" }]) {
      expect(segmentSchema.safeParse(bad).success).toBe(false);
    }
  });
});
