import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { OptionalAuth } from "../../common/auth/optional-auth.decorator";
import { Public } from "../../common/auth/public.decorator";
import { AppError } from "../../common/errors/app-error";
import { AuthGuard } from "./auth.guard";

class Sample {
  @OptionalAuth()
  optional() {}

  @AuthenticatedOnly()
  required() {}

  @Public()
  open() {}
}

function ctx(handler: () => void, headers: Record<string, string> = {}) {
  const req: { headers: Record<string, string>; user?: { id: string; sessionId: string } } = { headers };
  const context = { getHandler: () => handler, getClass: () => Sample, switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { context, req };
}

describe("AuthGuard", () => {
  const sample = new Sample();
  const tokens = { verifyAccess: jest.fn() };
  const sessions = { isRevoked: jest.fn() };
  const statuses = { get: jest.fn() };
  const guard = new AuthGuard(new Reflector(), tokens as never, sessions as never, statuses as never);

  beforeEach(() => {
    jest.resetAllMocks();
    tokens.verifyAccess.mockReturnValue({ sub: "user-1", sid: "sid-1" });
    statuses.get.mockResolvedValue("ACTIVE");
    sessions.isRevoked.mockResolvedValue(false);
  });

  it("optional-auth: no Authorization header passes as a visitor, with no user attached", async () => {
    const { context, req } = ctx(sample.optional);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toBeUndefined();
    expect(tokens.verifyAccess).not.toHaveBeenCalled();
  });

  it("optional-auth: a good token attaches the user", async () => {
    const { context, req } = ctx(sample.optional, { authorization: "Bearer good" });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toEqual({ id: "user-1", sessionId: "sid-1" });
  });

  it("optional-auth: a token that is sent is checked exactly as on a protected route (bad, malformed, suspended, revoked)", async () => {
    tokens.verifyAccess.mockImplementation(() => {
      throw new AppError("AUTH_TOKEN_INVALID", 401, "Invalid access token");
    });
    await expect(guard.canActivate(ctx(sample.optional, { authorization: "Bearer bad" }).context)).rejects.toMatchObject({ status: 401 });
    await expect(guard.canActivate(ctx(sample.optional, { authorization: "Basic abc" }).context)).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
    tokens.verifyAccess.mockReset();
    tokens.verifyAccess.mockReturnValue({ sub: "user-1", sid: "sid-1" });
    statuses.get.mockResolvedValue("SUSPENDED");
    await expect(guard.canActivate(ctx(sample.optional, { authorization: "Bearer ok" }).context)).rejects.toMatchObject({ code: "AUTH_ACCOUNT_SUSPENDED", status: 403 });
    statuses.get.mockResolvedValue("ACTIVE");
    sessions.isRevoked.mockResolvedValue(true);
    await expect(guard.canActivate(ctx(sample.optional, { authorization: "Bearer ok" }).context)).rejects.toMatchObject({ code: "AUTH_SESSION_REVOKED", status: 401 });
  });

  it("a protected route without a token is still 401, and a public route still skips authentication", async () => {
    await expect(guard.canActivate(ctx(sample.required).context)).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
    await expect(guard.canActivate(ctx(sample.open).context)).resolves.toBe(true);
  });
});
