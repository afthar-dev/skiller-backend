import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { applyTestEnv } from "../../../test/setup/env";
import { FakeClock } from "../../../test/support/fake-clock";
import { CLOCK } from "../../common/clock/clock";
import { ConfigModule } from "../../common/config/config.module";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { PrismaService } from "../../common/prisma/prisma.service";
import { REDIS } from "../../common/redis/redis.constants";
import { RedisModule } from "../../common/redis/redis.module";
import { PermissionRegistry, permissionRegistry } from "./permission.registry";
import { PermissionService } from "./permission.service";
import { syncPermissions } from "./permission-sync";
import "./permissions";

const uid = () => randomUUID().replace(/-/g, "").slice(0, 12);

describe("PermissionService", () => {
  let moduleRef: TestingModule;
  let svc: PermissionService;
  let prisma: PrismaService;
  let redis: Redis;
  const clock = new FakeClock();

  beforeAll(async () => {
    applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule, RedisModule],
      providers: [PermissionService, { provide: CLOCK, useValue: clock }],
    }).compile();
    await moduleRef.init();
    svc = moduleRef.get(PermissionService);
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(REDIS);
    await syncPermissions(prisma, permissionRegistry);
  });

  afterAll(() => moduleRef?.close());

  const mkUser = () => prisma.user.create({ data: { email: `perm-${uid()}@example.com` } });
  const mkRole = async (permKeys: string[], scope: "PLATFORM" | "ORG" = "PLATFORM") => {
    const perms = await prisma.permission.findMany({ where: { key: { in: permKeys } } });
    expect(perms).toHaveLength(permKeys.length);
    return prisma.role.create({
      data: { key: `r_${uid()}`, name: "test role", scope, rolePermissions: { create: perms.map((p) => ({ permissionId: p.id })) } },
    });
  };
  const grant = (userId: string, roleId: string, extra: { orgId?: string; expiresAt?: Date } = {}) =>
    prisma.userRole.create({ data: { userId, roleId, orgId: extra.orgId ?? null, expiresAt: extra.expiresAt ?? null } });

  describe("syncPermissions", () => {
    const cloneRegistry = () => {
      const copy = new PermissionRegistry();
      for (const def of permissionRegistry.all()) copy.register(def);
      return copy;
    };

    it("is idempotent", async () => {
      await syncPermissions(prisma, cloneRegistry());
      const countBefore = await prisma.permission.count();
      const grantsBefore = await prisma.rolePermission.count();
      const second = await syncPermissions(prisma, cloneRegistry());
      expect(second.inserted).toEqual([]);
      expect(await prisma.permission.count()).toBe(countBefore);
      expect(await prisma.rolePermission.count()).toBe(grantsBefore);
    });

    it("inserts a key newly added in code and grants it to super_admin", async () => {
      const registry = cloneRegistry();
      const key = `synctest.k_${uid()}`;
      registry.register({ key, module: "synctest", description: "added later" });
      const result = await syncPermissions(prisma, registry);
      expect(result.inserted).toEqual([key]);

      const row = await prisma.permission.findUniqueOrThrow({ where: { key } });
      expect(row).toMatchObject({ module: "synctest", description: "added later" });
      const superAdmin = await prisma.role.findUniqueOrThrow({ where: { key: "super_admin" } });
      expect(await prisma.rolePermission.count({ where: { roleId: superAdmin.id, permissionId: row.id } })).toBe(1);

      expect((await syncPermissions(prisma, registry)).inserted).toEqual([]);
    });

    it("reports keys present in the DB but not in code as orphans and never deletes them", async () => {
      const key = `orphan.k_${uid()}`;
      await prisma.permission.create({ data: { key, description: "gone from code", module: "orphan" } });
      const result = await syncPermissions(prisma, cloneRegistry());
      expect(result.orphans).toContain(key);
      expect(await prisma.permission.count({ where: { key } })).toBe(1);
    });
  });

  describe("effective / has", () => {
    it("org-scoped grant passes for that org and fails for another org", async () => {
      const user = await mkUser();
      const role = await mkRole(["org.manage"], "ORG");
      const orgA = `org-${uid()}`;
      const orgB = `org-${uid()}`;
      await grant(user.id, role.id, { orgId: orgA });

      expect(await svc.has(user.id, "org.manage", orgA)).toBe(true);
      expect(await svc.has(user.id, "org.manage", orgB)).toBe(false);
      expect(await svc.has(user.id, "org.manage")).toBe(false); // no platform grant
      const eff = await svc.effective(user.id);
      expect([...eff.platform]).toEqual([]);
      expect([...(eff.byOrg.get(orgA) ?? [])]).toEqual(["org.manage"]);
    });

    it("a platform grant satisfies any org", async () => {
      const user = await mkUser();
      const role = await mkRole(["user.view"]);
      await grant(user.id, role.id);
      expect(await svc.has(user.id, "user.view")).toBe(true);
      expect(await svc.has(user.id, "user.view", `org-${uid()}`)).toBe(true);
      expect(await svc.has(user.id, "user.suspend")).toBe(false);
    });

    it("ignores an expired UserRole, including one that expires while cached", async () => {
      const user = await mkUser();
      const role = await mkRole(["user.view"]);
      await grant(user.id, role.id, { expiresAt: new Date(clock.now().getTime() - 1000) });
      expect(await svc.has(user.id, "user.view")).toBe(false);

      const user2 = await mkUser();
      await grant(user2.id, role.id, { expiresAt: new Date(clock.now().getTime() + 60_000) });
      expect(await svc.has(user2.id, "user.view")).toBe(true); // now cached
      const ttl = await redis.ttl(`perm:${user2.id}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60); // cache never outlives the earliest grant expiry

      clock.advanceSec(61);
      await redis.del(`perm:${user2.id}`); // emulate the (shortened) TTL elapsing
      expect(await svc.has(user2.id, "user.view")).toBe(false);
    });

    it("caches in perm:{userId} with a 10 minute TTL", async () => {
      const user = await mkUser();
      const role = await mkRole(["user.view"]);
      await grant(user.id, role.id);
      await svc.effective(user.id);
      const ttl = await redis.ttl(`perm:${user.id}`);
      expect(ttl).toBeGreaterThan(590);
      expect(ttl).toBeLessThanOrEqual(600);
    });
  });

  describe("invalidation", () => {
    it("invalidateUser makes a direct grant change visible immediately", async () => {
      const user = await mkUser();
      const role = await mkRole(["user.view"]);
      const ur = await grant(user.id, role.id);
      expect(await svc.has(user.id, "user.view")).toBe(true);
      await prisma.userRole.delete({ where: { id: ur.id } });
      expect(await svc.has(user.id, "user.view")).toBe(true); // stale until invalidated
      await svc.invalidateUser(user.id);
      expect(await svc.has(user.id, "user.view")).toBe(false);
    });

    it("removing a permission from a role + invalidateRole flips `has` for every holder without waiting for the TTL", async () => {
      const role = await mkRole(["user.view", "media.manage_any"]);
      const holders = await Promise.all([mkUser(), mkUser()]);
      for (const h of holders) await grant(h.id, role.id);
      const bystander = await mkUser();
      const otherRole = await mkRole(["user.view"]);
      await grant(bystander.id, otherRole.id);
      for (const h of [...holders, bystander]) expect(await svc.has(h.id, "user.view")).toBe(true);

      const perm = await prisma.permission.findUniqueOrThrow({ where: { key: "media.manage_any" } });
      await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } } });
      for (const h of holders) expect(await svc.has(h.id, "media.manage_any")).toBe(true); // cached

      await svc.invalidateRole(role.id);
      for (const h of holders) {
        expect(await svc.has(h.id, "media.manage_any")).toBe(false);
        expect(await svc.has(h.id, "user.view")).toBe(true);
      }
      expect(await redis.exists(`perm:${bystander.id}`)).toBe(1); // untouched
    });
  });
});
