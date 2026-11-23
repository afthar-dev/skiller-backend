import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { OptionalAuth } from "../auth/optional-auth.decorator";
import { Public } from "../auth/public.decorator";
import { RateLimit } from "./rate-limit.decorator";
import { RateLimitGuard } from "./rate-limit.guard";

class Sample {
  @Public()
  @RateLimit({ key: (req) => `pub:${req.ip}`, limit: 2, windowSec: 60 })
  publicRead() {}

  @OptionalAuth()
  @RateLimit({ key: (req) => `opt:${req.ip}`, limit: 2, windowSec: 60, anonymousOnly: true })
  optionalRead() {}

  @RateLimit({ key: (req) => `priv:${req.ip}`, limit: 2, windowSec: 60 })
  privateRead() {}
}

const SECRET = "s".repeat(40);
const trusted = { "x-skiller-server": SECRET, "x-skiller-client-ip": "203.0.113.9" };

function ctx(handler: () => void, headers: Record<string, string>, method: string) {
  const req = { body: {}, ip: "10.0.0.1", headers, method };
  const context = { getHandler: () => handler, getClass: () => Sample, switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { context, req };
}

describe("RateLimitGuard: X-Skiller-Client-Ip is honoured only on public reads", () => {
  const redis = { eval: jest.fn().mockResolvedValue([1, 0]) };
  const guard = new RateLimitGuard(new Reflector(), redis as never, { ssrSharedSecret: SECRET });
  const sample = new Sample();

  it.each([
    ["a public GET", () => sample.publicRead, "GET", "203.0.113.9"],
    ["a signed-out optional-auth GET", () => sample.optionalRead, "GET", "203.0.113.9"],
    ["a public POST (otp/request, otp/verify)", () => sample.publicRead, "POST", "10.0.0.1"],
    ["an authenticated GET", () => sample.privateRead, "GET", "10.0.0.1"],
    ["an authenticated POST (admin mutation)", () => sample.privateRead, "POST", "10.0.0.1"],
  ])("%s", async (_name, handler, method, expectedIp) => {
    const { context, req } = ctx(handler(), trusted, method);
    await guard.canActivate(context);
    expect(req.ip).toBe(expectedIp);
  });

  it("an optional-auth GET that carries a token keeps the caller's own address", async () => {
    const { context, req } = ctx(sample.optionalRead, { ...trusted, authorization: "Bearer x" }, "GET");
    await guard.canActivate(context);
    expect(req.ip).toBe("10.0.0.1");
  });
});
