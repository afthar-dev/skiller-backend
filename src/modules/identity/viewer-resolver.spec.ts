import { ViewerResolver } from "./viewer-resolver";

describe("ViewerResolver", () => {
  const tokens = { verifyAccess: jest.fn() };
  const sessions = { isRevoked: jest.fn() };
  const statuses = { get: jest.fn() };
  const resolver = new ViewerResolver(tokens as never, sessions as never, statuses as never);
  const req = { headers: { authorization: "Bearer abc" } } as never;

  beforeEach(() => {
    jest.resetAllMocks();
    tokens.verifyAccess.mockReturnValue({ sub: "u1", sid: "s1" });
    sessions.isRevoked.mockResolvedValue(false);
    statuses.get.mockResolvedValue("ACTIVE");
  });

  it("names an active user with a live session", async () => {
    await expect(resolver.viewerId(req)).resolves.toBe("u1");
  });

  it.each(["SUSPENDED", "DELETED", null])("treats a valid token of a %s account as anonymous", async (status) => {
    statuses.get.mockResolvedValue(status);
    await expect(resolver.viewerId(req)).resolves.toBeNull();
  });

  it("treats a revoked session and a bad token as anonymous, and a status lookup failure fails closed", async () => {
    sessions.isRevoked.mockResolvedValue(true);
    await expect(resolver.viewerId(req)).resolves.toBeNull();
    sessions.isRevoked.mockResolvedValue(false);
    statuses.get.mockRejectedValue(new Error("redis down"));
    await expect(resolver.viewerId(req)).resolves.toBeNull();
    tokens.verifyAccess.mockImplementation(() => {
      throw new Error("bad");
    });
    await expect(resolver.viewerId(req)).resolves.toBeNull();
  });
});
