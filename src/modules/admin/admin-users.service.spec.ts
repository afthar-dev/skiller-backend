import { AdminUsersService } from "./admin-users.service";

describe("AdminUsersService.revokeSessions", () => {
  const SUPER = ["super_admin"];
  const build = (roleKeys: Record<string, string[]>) => {
    const sessions = { countActive: jest.fn().mockResolvedValue(2), revokeAllForUser: jest.fn().mockResolvedValue(undefined) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const prisma = { $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn({})) };
    const accounts = { find: jest.fn().mockResolvedValue({ id: "x" }) };
    const roles = { platformRoleKeys: jest.fn(async (id: string) => roleKeys[id] ?? []) };
    const svc = new AdminUsersService(prisma as never, accounts as never, {} as never, roles as never, sessions as never, {} as never, audit as never);
    return { svc, sessions, audit };
  };

  it("support cannot revoke a super admin's sessions (ROLE_ESCALATION_DENIED) and nothing is revoked or audited", async () => {
    const { svc, sessions, audit } = build({ support: ["support"], boss: SUPER });
    await expect(svc.revokeSessions("support", "boss")).rejects.toMatchObject({ code: "ROLE_ESCALATION_DENIED", status: 403 });
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("a super admin can revoke another super admin's sessions, and support can revoke an ordinary user's", async () => {
    const a = build({ boss: SUPER, boss2: SUPER });
    await expect(a.svc.revokeSessions("boss", "boss2")).resolves.toEqual({ id: "boss2", revoked: 2 });
    const b = build({ support: ["support"] });
    await expect(b.svc.revokeSessions("support", "plain")).resolves.toEqual({ id: "plain", revoked: 2 });
  });
});
