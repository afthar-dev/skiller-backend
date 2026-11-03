import { Controller, Get, Param, Post } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { PermissionService } from "../../src/modules/rbac/permission.service";
import { RequirePermission } from "../../src/modules/rbac/require-permission.decorator";
import { createTestApp } from "../setup/app";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

@Controller("test-access")
class AccessTestController {
  @Get("users")
  @RequirePermission("user.view")
  users() {
    return { ok: true };
  }

  @Get("orgs/:orgId")
  @RequirePermission("org.manage", { orgParam: "orgId" })
  org(@Param("orgId") orgId: string) {
    return { orgId };
  }
}

@Controller("test-leak")
class LeakyController {
  @Post("open-door")
  openDoor() {
    return { open: true };
  }
}

describe("access control", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  const http = () => request(t.app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    t = await createAuthTestApp({ controllers: [AccessTestController] });
    prisma = t.app.get(PrismaService);
  });

  afterAll(() => t?.close());

  const grantRole = async (userId: string, roleKey: string, orgId: string | null = null) => {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    await prisma.userRole.create({ data: { userId, roleId: role.id, orgId } });
    await t.app.get(PermissionService).invalidateUser(userId); // what RolesService does on every grant
  };

  it("no token or an invalid token on a @RequirePermission route is 401, never 403", async () => {
    const none = await http().get("/v1/test-access/users");
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe("AUTH_REQUIRED");

    const bad = await http().get("/v1/test-access/users").set(auth("not-a-real-token"));
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).not.toBe("FORBIDDEN");

    const malformed = await http().get("/v1/test-access/orgs/o1").set("Authorization", "Basic abc");
    expect(malformed.status).toBe(401);
  });

  it("an authenticated user without the permission gets 403 FORBIDDEN; with the role gets 200", async () => {
    const me = await t.login();
    const denied = await http().get("/v1/test-access/users").set(auth(me.accessToken));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("FORBIDDEN");

    await grantRole(me.userId, "support"); // support: user.view, user.revoke_sessions, audit.view
    const ok = await http().get("/v1/test-access/users").set(auth(me.accessToken));
    expect(ok.status).toBe(200);
  });

  it("orgParam routes pass only for the org the user holds the role in", async () => {
    const me = await t.login();
    const orgA = `org-${randomUUID()}`;
    const orgB = `org-${randomUUID()}`;
    await grantRole(me.userId, "org_owner", orgA);

    const a = await http().get(`/v1/test-access/orgs/${orgA}`).set(auth(me.accessToken));
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ orgId: orgA });
    const b = await http().get(`/v1/test-access/orgs/${orgB}`).set(auth(me.accessToken));
    expect(b.status).toBe(403);
  });

  it("the app refuses to boot when a route has no @RequirePermission, @Public or @AuthenticatedOnly", async () => {
    await expect(createTestApp(undefined, { controllers: [LeakyController] })).rejects.toThrow(/POST \/v1\/test-leak\/open-door/);
  });
});
