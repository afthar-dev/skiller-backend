import { createHash } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { PermissionService } from "../../src/modules/rbac/permission.service";
import { AuthTestApp, createAuthTestApp, uniqueEmail } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

describe("organizations and invites", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const uniq = () => Math.random().toString(36).slice(2, 10);

  const createOrg = (s: Session, body: object = {}) =>
    http()
      .post("/v1/orgs")
      .set(auth(s))
      .send({ name: "Acme Academy", slug: `acme-${uniq()}`, ...body });
  const invite = (s: Session, slug: string, body: object) => http().post(`/v1/orgs/${slug}/invites`).set(auth(s)).send(body);
  const accept = (s: Session, token: string) => http().post("/v1/org-invites/accept").set(auth(s)).send({ token });

  /** Waits for the invite mail to `email` and returns the raw token from its link. */
  async function tokenFor(email: string, after = 0): Promise<string> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const list = t.mail.sent.filter((m) => m.to === email.toLowerCase() && /invited/i.test(m.subject));
      if (list.length > after) {
        const match = /token=([A-Za-z0-9_-]{20,})/.exec(list[list.length - 1].text);
        if (match) return match[1];
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no invite mail for ${email}`);
  }

  async function ownerWithOrg() {
    const owner = await t.login();
    const res = await createOrg(owner);
    expect(res.status).toBe(201);
    return { owner, org: res.body as { id: string; slug: string } };
  }

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
  });
  afterAll(() => t?.close());

  describe("create / read / update", () => {
    it("a member creates an org and becomes its org_owner (for that org only)", async () => {
      const { owner, org } = await ownerWithOrg();
      const rows = await prisma.userRole.findMany({ where: { userId: owner.userId, orgId: org.id }, include: { role: true } });
      expect(rows.map((r) => r.role.key)).toEqual(["org_owner"]);
      const perms = t.app.get(PermissionService);
      expect(await perms.has(owner.userId, "org.manage", org.id)).toBe(true);
      expect(await perms.has(owner.userId, "org.manage", "some-other-org")).toBe(false);
      expect(await perms.has(owner.userId, "org.manage")).toBe(false);
    });

    it("requires auth, a valid slug, and a unique slug", async () => {
      expect((await http().post("/v1/orgs").send({ name: "x" })).status).toBe(401);
      const s = await t.login();
      const bad = await createOrg(s, { slug: "Bad Slug!" });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("VALIDATION_FAILED");
      const slug = `dup-${uniq()}`;
      expect((await createOrg(s, { slug })).status).toBe(201);
      const again = await createOrg(await t.login(), { slug: slug.toUpperCase() });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("ORG_SLUG_TAKEN");
    });

    it("GET /orgs/:slug is public; unknown slug is 404", async () => {
      const { org } = await ownerWithOrg();
      const res = await http().get(`/v1/orgs/${org.slug}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: org.id, slug: org.slug, name: "Acme Academy" });
      const missing = await http().get(`/v1/orgs/nope-${uniq()}`);
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe("ORG_NOT_FOUND");
    });

    it("PATCH needs org.manage in that org; logo ids are not accepted yet", async () => {
      const { owner, org } = await ownerWithOrg();
      const ok = await http().patch(`/v1/orgs/${org.slug}`).set(auth(owner)).send({ name: "Renamed", about: "hi" });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ name: "Renamed", about: "hi" });

      const stranger = await t.login();
      expect((await http().patch(`/v1/orgs/${org.slug}`).set(auth(stranger)).send({ name: "Hax" })).status).toBe(403);
      expect((await http().patch(`/v1/orgs/${org.slug}`).send({ name: "Hax" })).status).toBe(401);

      const logo = await http().patch(`/v1/orgs/${org.slug}`).set(auth(owner)).send({ logoAssetId: "x" });
      expect(logo.status).toBe(400);

      // an owner of another org cannot manage this one
      const { owner: other } = await ownerWithOrg();
      expect((await http().patch(`/v1/orgs/${org.slug}`).set(auth(other)).send({ name: "Hax" })).status).toBe(403);
    });
  });

  describe("invites", () => {
    it("owner invites, invitee accepts and holds org_instructor only in that org", async () => {
      const { owner, org } = await ownerWithOrg();
      const { org: otherOrg } = await ownerWithOrg();
      const email = uniqueEmail("invitee");

      const res = await invite(owner, org.slug, { email: email.toUpperCase(), roleKey: "org_instructor" });
      expect(res.status).toBe(201);
      const token = await tokenFor(email);

      // only the hash is stored
      const row = await prisma.orgInvite.findFirstOrThrow({ where: { orgId: org.id, email } });
      expect(row.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
      expect(JSON.stringify(row)).not.toContain(token);
      expect(row.expiresAt.getTime() - t.clock.now().getTime()).toBeGreaterThan(6.9 * 86_400_000);
      expect(row.expiresAt.getTime() - t.clock.now().getTime()).toBeLessThan(7.1 * 86_400_000);

      const invitee = await t.login(email);
      const acc = await accept(invitee, token);
      expect(acc.status).toBe(200);
      expect(acc.body).toMatchObject({ orgId: org.id, slug: org.slug, roleKey: "org_instructor" });

      const grants = await prisma.userRole.findMany({ where: { userId: invitee.userId, orgId: { not: null } }, include: { role: true } });
      expect(grants.map((g) => [g.role.key, g.orgId])).toEqual([["org_instructor", org.id]]);
      const perms = t.app.get(PermissionService);
      expect(await perms.has(invitee.userId, "org.invite", org.id)).toBe(false);
      expect(await perms.has(invitee.userId, "org.manage", otherOrg.id)).toBe(false);
      expect((await prisma.orgInvite.findUniqueOrThrow({ where: { id: row.id } })).acceptedAt).not.toBeNull();

      const me = await http().get("/v1/me").set(auth(invitee));
      expect(me.body.roles).toEqual(["member"]); // org roles are not platform roles
    });

    it("an instructor cannot invite (403 FORBIDDEN); a non-member cannot either", async () => {
      const { owner, org } = await ownerWithOrg();
      const email = uniqueEmail("instr");
      await invite(owner, org.slug, { email, roleKey: "org_instructor" });
      const instructor = await t.login(email);
      expect((await accept(instructor, await tokenFor(email))).status).toBe(200);

      const denied = await invite(instructor, org.slug, { email: uniqueEmail(), roleKey: "org_learner" });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("FORBIDDEN");
      expect((await invite(await t.login(), org.slug, { email: uniqueEmail(), roleKey: "org_learner" })).status).toBe(403);
    });

    it("only org_instructor / org_learner can be invited", async () => {
      const { owner, org } = await ownerWithOrg();
      for (const roleKey of ["org_owner", "super_admin", "member", "nope"]) {
        const res = await invite(owner, org.slug, { email: uniqueEmail(), roleKey });
        expect(res.status).toBe(400);
      }
      expect((await invite(owner, org.slug, { email: "not-an-email", roleKey: "org_learner" })).status).toBe(400);
    });

    it("accepting while logged in as a different email fails and leaves the invite usable", async () => {
      const { owner, org } = await ownerWithOrg();
      const email = uniqueEmail("right");
      await invite(owner, org.slug, { email, roleKey: "org_learner" });
      const token = await tokenFor(email);

      const wrong = await t.login();
      const res = await accept(wrong, token);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INVITE_EMAIL_MISMATCH");
      expect(await prisma.userRole.count({ where: { userId: wrong.userId, orgId: org.id } })).toBe(0);

      const right = await t.login(email);
      expect((await accept(right, token)).status).toBe(200);
    });

    it("a used invite is INVITE_USED; an expired one is INVITE_EXPIRED; garbage is INVITE_INVALID", async () => {
      const { owner, org } = await ownerWithOrg();
      const email = uniqueEmail("once");
      await invite(owner, org.slug, { email, roleKey: "org_learner" });
      const token = await tokenFor(email);
      const invitee = await t.login(email);
      expect((await accept(invitee, token)).status).toBe(200);
      const reuse = await accept(invitee, token);
      expect(reuse.status).toBe(409);
      expect(reuse.body.error.code).toBe("INVITE_USED");

      const email2 = uniqueEmail("late");
      await invite(owner, org.slug, { email: email2, roleKey: "org_learner" });
      const token2 = await tokenFor(email2);
      await prisma.orgInvite.updateMany({ where: { orgId: org.id, email: email2 }, data: { expiresAt: new Date(t.clock.now().getTime() - 1000) } });
      const late = await accept(await t.login(email2), token2);
      expect(late.status).toBe(410);
      expect(late.body.error.code).toBe("INVITE_EXPIRED");

      const bad = await accept(invitee, "x".repeat(43));
      expect(bad.status).toBe(404);
      expect(bad.body.error.code).toBe("INVITE_INVALID");
      expect((await http().post("/v1/org-invites/accept").send({ token })).status).toBe(401);
    });

    it("concurrent accepts of one invite succeed exactly once", async () => {
      const { owner, org } = await ownerWithOrg();
      const email = uniqueEmail("race");
      await invite(owner, org.slug, { email, roleKey: "org_learner" });
      const token = await tokenFor(email);
      const invitee = await t.login(email);
      const results = await Promise.all(Array.from({ length: 4 }, () => accept(invitee, token)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    });

    it("re-inviting the same address supersedes the older pending invite", async () => {
      const { owner, org } = await ownerWithOrg();
      const email = uniqueEmail("again");
      await invite(owner, org.slug, { email, roleKey: "org_learner" });
      const first = await tokenFor(email);
      await invite(owner, org.slug, { email, roleKey: "org_instructor" });
      const second = await tokenFor(email, 1);
      expect(second).not.toBe(first);
      const invitee = await t.login(email);
      expect((await accept(invitee, first)).status).toBe(404);
      expect((await accept(invitee, second)).body.roleKey).toBe("org_instructor");
    });
  });

  describe("members", () => {
    it("lists members; the owner can remove an instructor but never the owner", async () => {
      const { owner, org } = await ownerWithOrg();
      const email = uniqueEmail("member");
      await invite(owner, org.slug, { email, roleKey: "org_instructor" });
      const member = await t.login(email);
      await accept(member, await tokenFor(email));

      const list = await http().get(`/v1/orgs/${org.slug}/members`).set(auth(owner));
      expect(list.status).toBe(200);
      expect(list.body.items.map((m: { userId: string; roleKey: string }) => [m.userId, m.roleKey]).sort()).toEqual(
        [[owner.userId, "org_owner"], [member.userId, "org_instructor"]].sort(),
      );
      expect(list.body.items[0]).toEqual(expect.objectContaining({ handle: expect.any(String), displayName: expect.any(String) }));

      const paged = await http().get(`/v1/orgs/${org.slug}/members?limit=1`).set(auth(owner));
      expect(paged.body.items).toHaveLength(1);
      expect(paged.body.nextCursor).toBeTruthy();

      // instructors cannot list or remove
      expect((await http().get(`/v1/orgs/${org.slug}/members`).set(auth(member))).status).toBe(403);

      const self = await http().delete(`/v1/orgs/${org.slug}/members/${owner.userId}`).set(auth(owner));
      expect(self.status).toBe(409);
      expect(self.body.error.code).toBe("ORG_OWNER_REQUIRED");

      const perms = t.app.get(PermissionService);
      expect(await perms.has(member.userId, "org.manage", org.id)).toBe(false);
      expect((await http().delete(`/v1/orgs/${org.slug}/members/${member.userId}`).set(auth(owner))).status).toBe(204);
      expect(await prisma.userRole.count({ where: { userId: member.userId, orgId: org.id } })).toBe(0);
      expect((await http().delete(`/v1/orgs/${org.slug}/members/${member.userId}`).set(auth(owner))).status).toBe(404);
    });
  });
});
