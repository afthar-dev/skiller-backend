import { originGuard, ORIGIN_SECRET_HEADER } from "./origin-guard.middleware";

const SECRET = "o".repeat(32);

function run(mw: ReturnType<typeof originGuard>, path: string, headers: Record<string, string> = {}) {
  const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  const next = jest.fn();
  mw({ path, headers } as never, res as never, next);
  return { res, next };
}

describe("originGuard", () => {
  it("is a pass-through when no secret is configured", () => {
    const { next } = run(originGuard(undefined), "/v1/me");
    expect(next).toHaveBeenCalled();
  });

  it("rejects requests that did not come through the proxy (missing or wrong secret) with 403", () => {
    const mw = originGuard(SECRET);
    for (const headers of [{} as Record<string, string>, { [ORIGIN_SECRET_HEADER]: "wrong".repeat(8) }, { [ORIGIN_SECRET_HEADER]: "" }]) {
      const { res, next } = run(mw, "/v1/me", headers);
      expect(res.statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("lets a request with the secret through, and always lets the health check through (the platform probes the origin directly)", () => {
    const mw = originGuard(SECRET);
    expect(run(mw, "/v1/me", { [ORIGIN_SECRET_HEADER]: SECRET }).next).toHaveBeenCalled();
    expect(run(mw, "/v1/health").next).toHaveBeenCalled();
  });
});
