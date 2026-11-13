import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { RolesService } from "../../src/modules/rbac";
import { givePlan } from "../support/billing";
import { courseFixtures } from "../support/course-fixtures";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";
import { checkDeclared } from "../support/openapi-shape";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);

/** The /v1/admin routes that were untyped before this change: each one is called below and its live response checked against openapi.json. */
const ROUTES = [
  "GET /v1/admin/users",
  "GET /v1/admin/users/{id}",
  "POST /v1/admin/users/{id}/suspend",
  "POST /v1/admin/users/{id}/unsuspend",
  "POST /v1/admin/users/{id}/revoke-sessions",
  "POST /v1/admin/users/{id}/roles",
  "DELETE /v1/admin/users/{id}/roles/{userRoleId}",
  "GET /v1/admin/roles",
  "POST /v1/admin/roles",
  "PATCH /v1/admin/roles/{id}",
  "DELETE /v1/admin/roles/{id}",
  "GET /v1/admin/permissions",
  "GET /v1/admin/audit",
  "GET /v1/admin/outbox/dead",
  "GET /v1/admin/settings",
  "PUT /v1/admin/settings",
  "GET /v1/admin/flags",
  "PUT /v1/admin/flags",
  "GET /v1/admin/moderation/reports",
  "POST /v1/admin/moderation/targets/{type}/{id}/uphold",
  "POST /v1/admin/moderation/targets/{type}/{id}/dismiss",
  "GET /v1/admin/courses/review-queue",
  "POST /v1/admin/courses/{id}/approve",
  "POST /v1/admin/courses/{id}/reject",
  "POST /v1/admin/courses/{id}/flag",
  "POST /v1/admin/courses/{id}/unflag",
  "POST /v1/admin/reviews/{id}/hide",
  "POST /v1/admin/reviews/{id}/unhide",
  "POST /v1/admin/questions/{id}/hide",
  "POST /v1/admin/questions/{id}/unhide",
  "POST /v1/admin/answers/{id}/hide",
  "POST /v1/admin/answers/{id}/unhide",
  "GET /v1/admin/course-categories",
  "POST /v1/admin/course-categories",
  "PATCH /v1/admin/course-categories/{id}",
  "DELETE /v1/admin/course-categories/{id}",
  "GET /v1/admin/campaigns",
  "POST /v1/admin/campaigns",
  "GET /v1/admin/campaigns/{id}",
  "PATCH /v1/admin/campaigns/{id}",
  "POST /v1/admin/campaigns/{id}/preview",
  "POST /v1/admin/campaigns/{id}/test-send",
  "POST /v1/admin/campaigns/{id}/approve",
  "POST /v1/admin/campaigns/{id}/send",
  "POST /v1/admin/campaigns/{id}/pause",
  "POST /v1/admin/campaigns/{id}/resume",
  "POST /v1/admin/campaigns/{id}/cancel",
  "GET /v1/admin/analytics/overview",
  "GET /v1/admin/analytics/series",
  "GET /v1/admin/analytics/funnel",
  "GET /v1/admin/analytics/export",
  "POST /v1/admin/analytics/rebuild",
  "GET /v1/admin/payout-accounts",
  "POST /v1/admin/payout-accounts/{id}/clear-flag",
  "POST /v1/admin/plans",
  "POST /v1/admin/plans/{id}/versions",
  "GET /v1/admin/subscriptions",
] as const;

interface Doc {
  paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema?: unknown }> }> }>>;
}
const openapi = () => JSON.parse(readFileSync(join(__dirname, "..", "..", "openapi.json"), "utf8")) as Doc;

const LIMITS = { max_published_courses: 5, storage_gb: 10, reels_per_day: 5, analytics_level: "basic", creator_coupons: false, org_seats: 1 };

// Every untyped-until-now admin response, checked against the schema committed in openapi.json, so a declared response cannot drift from what the handler returns.
describe("typed responses: admin", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let categoryId: string;
  let admin: Session;
  let second: Session;
  const seen = new Set<string>();
  const made = { flags: [] as string[], plans: [] as string[], roles: [] as string[], categories: [] as string[] };
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  /** The response must have `status` and match the schema declared for `key`. */
  const declared = <T extends { status: number; body: unknown }>(res: T, key: string, status: number): T => {
    expect([res.status, JSON.stringify(res.body).slice(0, 300)]).toEqual([status, expect.any(String)]);
    seen.add(key);
    return checkDeclared(res, key);
  };
  const noContent = (res: { status: number; body: unknown }, key: string) => {
    expect([res.status, JSON.stringify(res.body).slice(0, 300)]).toEqual([204, expect.any(String)]);
    seen.add(key);
  };
  const get = (path: string, s: Session = admin) => http().get(path).set(auth(s));
  const post = (path: string, body: Record<string, unknown> = {}, s: Session = admin) => http().post(path).set(auth(s)).send(body);

  async function stepUp(s: Session) {
    const before = t.mail.sent.filter((m) => m.to === s.email).length;
    const res = await http().post("/v1/auth/step-up/request").set(auth(s)).set("X-Forwarded-For", uniqueIp());
    expect(res.status).toBe(202);
    const code = await t.codeFor(s.email, before);
    await http().post("/v1/auth/step-up/verify").set(auth(s)).send({ challengeId: res.body.challengeId, code }).expect(204);
  }
  async function superAdmin() {
    const s = await t.login();
    await t.app.get(RolesService).grantSystem(s.userId, "super_admin");
    await stepUp(s);
    return s;
  }
  let steppedAt = Date.now();
  /** Step-up lasts five minutes; this suite runs longer, so it is renewed when it gets old. */
  beforeEach(async () => {
    if (Date.now() - steppedAt < 120_000) return;
    await stepUp(admin);
    await stepUp(second);
    steppedAt = Date.now();
  });

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
    admin = await superAdmin();
    second = await superAdmin();
    steppedAt = Date.now();
  });
  afterAll(async () => {
    if (prisma) {
      await prisma.featureFlag.deleteMany({ where: { key: { in: made.flags } } });
      await prisma.planVersion.deleteMany({ where: { planId: { in: made.plans } } });
      await prisma.plan.deleteMany({ where: { id: { in: made.plans } } });
      await prisma.category.deleteMany({ where: { id: { in: made.categories } } });
    }
    await t?.close();
  });

  const fixtures = () => courseFixtures(t, prisma, categoryId);

  it("users, sessions, roles, permissions, audit and the dead outbox", async () => {
    const victim = await t.login();
    expect((await get("/v1/me", victim)).status).toBe(200); // creates the profile
    const found = declared(await get(`/v1/admin/users?q=${encodeURIComponent(victim.email)}&status=ACTIVE`), "GET /v1/admin/users", 200);
    expect(found.body.items.map((u: { id: string }) => u.id)).toEqual([victim.userId]);
    declared(await get("/v1/admin/users?role=super_admin"), "GET /v1/admin/users", 200);
    declared(await get("/v1/admin/users"), "GET /v1/admin/users", 200);

    expect(declared(await post(`/v1/admin/users/${victim.userId}/suspend`, { reason: "contract check" }), "POST /v1/admin/users/{id}/suspend", 200).body).toMatchObject({ status: "SUSPENDED", changed: true });
    declared(await post(`/v1/admin/users/${victim.userId}/suspend`, { reason: "again" }), "POST /v1/admin/users/{id}/suspend", 200);
    expect(declared(await post(`/v1/admin/users/${victim.userId}/unsuspend`), "POST /v1/admin/users/{id}/unsuspend", 200).body).toMatchObject({ status: "ACTIVE", changed: true });
    declared(await post(`/v1/admin/users/${victim.userId}/revoke-sessions`), "POST /v1/admin/users/{id}/revoke-sessions", 200);

    const key = `ct_${uniq()}`;
    const role = declared(await post("/v1/admin/roles", { key, name: "Contract role", scope: "PLATFORM", permissionKeys: ["audit.view"] }), "POST /v1/admin/roles", 201);
    made.roles.push(role.body.id);
    const roles = declared(await get("/v1/admin/roles"), "GET /v1/admin/roles", 200);
    expect(roles.body.items.some((r: { key: string }) => r.key === key)).toBe(true);
    const perms = declared(await get("/v1/admin/permissions"), "GET /v1/admin/permissions", 200);
    expect(perms.body.items.length).toBeGreaterThan(5);
    declared(await http().patch(`/v1/admin/roles/${role.body.id}`).set(auth(admin)).send({ name: "Renamed role", permissionKeys: ["audit.view", "user.view"] }), "PATCH /v1/admin/roles/{id}", 200);

    const grant = declared(await post(`/v1/admin/users/${victim.userId}/roles`, { roleKey: key, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), "POST /v1/admin/users/{id}/roles", 201);
    const detail = declared(await get(`/v1/admin/users/${victim.userId}`), "GET /v1/admin/users/{id}", 200);
    expect(detail.body.roles.map((r: { id: string }) => r.id)).toContain(grant.body.id);
    expect(detail.body.recentAudit.length).toBeGreaterThan(0);
    expect(detail.body.profile).not.toBeNull();
    noContent(await http().delete(`/v1/admin/users/${victim.userId}/roles/${grant.body.id}`).set(auth(admin)), "DELETE /v1/admin/users/{id}/roles/{userRoleId}");
    noContent(await http().delete(`/v1/admin/roles/${role.body.id}`).set(auth(admin)), "DELETE /v1/admin/roles/{id}");

    const audit = declared(await get(`/v1/admin/audit?targetType=user&targetId=${victim.userId}`), "GET /v1/admin/audit", 200);
    expect(audit.body.items.some((a: { action: string; before: unknown }) => a.action === "user.suspend" && a.before !== null)).toBe(true);
    declared(await get("/v1/admin/audit"), "GET /v1/admin/audit", 200);

    const marker = uniq();
    await prisma.outboxEvent.create({ data: { type: "user.registered", payload: { userId: randomUUID(), email: `dead-${marker}@example.com` }, publishedAt: new Date(), attempts: 3, deadAt: new Date(), lastError: `boom ${marker}` } });
    const dead = declared(await get("/v1/admin/outbox/dead"), "GET /v1/admin/outbox/dead", 200);
    expect(dead.body.items.some((e: { lastError: string }) => e.lastError === `boom ${marker}`)).toBe(true);
  });

  it("settings and feature flags", async () => {
    const list = declared(await get("/v1/admin/settings"), "GET /v1/admin/settings", 200);
    const current = (k: string) => (list.body.items as { key: string; value: unknown }[]).find((s) => s.key === k)!.value;
    // The same value written back: a number, a string and a boolean, so no setting is left changed for the other suites.
    for (const k of ["hold_days", "platform_legal_name", "marketing_opt_in_required"]) {
      const saved = declared(await http().put("/v1/admin/settings").set(auth(admin)).send({ key: k, value: current(k) }), "PUT /v1/admin/settings", 200);
      expect(saved.body).toEqual({ key: k, value: current(k) });
    }

    const user = await t.login();
    const withRules = `ctflag_${uniq()}`;
    const plain = `ctflag_${uniq()}`;
    made.flags.push(withRules, plain);
    const flag = declared(await http().put("/v1/admin/flags").set(auth(admin)).send({ key: withRules, enabled: true, rules: { percent: 25, allowUserIds: [user.userId] } }), "PUT /v1/admin/flags", 200);
    expect(flag.body.rules).toEqual({ percent: 25, allowUserIds: [user.userId] });
    expect(declared(await http().put("/v1/admin/flags").set(auth(admin)).send({ key: plain, enabled: false }), "PUT /v1/admin/flags", 200).body.rules).toBeNull();
    const flags = declared(await get("/v1/admin/flags"), "GET /v1/admin/flags", 200);
    expect(flags.body.items.map((f: { key: string }) => f.key)).toEqual(expect.arrayContaining([withRules, plain]));
  });

  it("moderation: the queue, uphold and dismiss", async () => {
    const fx = fixtures();
    const owner = await fx.creator();
    const asset = (ownerId: string) => prisma.mediaAsset.create({ data: { ownerId, purpose: "REEL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30, attachedAt: new Date() } });
    const reel = async () => prisma.reel.create({ data: { creatorId: owner.userId, mediaAssetId: (await asset(owner.userId)).id, caption: "a reel to review", hashtags: [], status: "PUBLISHED", publishedAt: new Date() } });
    const [upheld, dismissed] = [await reel(), await reel()];
    const reporters = await Promise.all([t.login(), t.login()]);
    for (const r of reporters) {
      for (const target of [upheld, dismissed]) {
        expect((await post("/v1/reports", { targetType: "REEL", targetId: target.id, reason: "SPAM", note: "ad" }, r)).status).toBe(201);
      }
    }
    // A course review reported too, so the queue also carries a non-reel preview.
    const c = await publishedFreeCourse(owner);
    const reviewer = await enrol(c.slug);
    const review = await http().put(`/v1/courses/${c.slug}/reviews/mine`).set(auth(reviewer)).send({ rating: 2, body: "meh" });
    expect(review.status).toBe(200);
    expect((await post("/v1/reports", { targetType: "COURSE_REVIEW", targetId: review.body.id, reason: "HARASSMENT" }, reporters[0])).status).toBe(201);

    const queue = declared(await get("/v1/admin/moderation/reports?type=REEL&limit=100"), "GET /v1/admin/moderation/reports", 200);
    const row = queue.body.items.find((i: { targetId: string }) => i.targetId === upheld.id);
    expect(row).toMatchObject({ targetType: "REEL", reportCount: 2, reasons: { SPAM: 2 }, autoHidden: false });
    declared(await get("/v1/admin/moderation/reports?limit=100"), "GET /v1/admin/moderation/reports", 200);

    const up = declared(await post(`/v1/admin/moderation/targets/reel/${upheld.id}/uphold`, { note: "spam" }), "POST /v1/admin/moderation/targets/{type}/{id}/uphold", 200);
    expect(up.body).toMatchObject({ decision: "UPHELD", reports: 2, restored: false, restrictedUntil: null });
    expect(up.body.strike).not.toBeNull();
    const down = declared(await post(`/v1/admin/moderation/targets/reel/${dismissed.id}/dismiss`, { note: "fine" }), "POST /v1/admin/moderation/targets/{type}/{id}/dismiss", 200);
    expect(down.body).toMatchObject({ decision: "DISMISSED", strike: null });
    declared(await post(`/v1/admin/moderation/targets/course-review/${review.body.id}/dismiss`, { note: "fine" }), "POST /v1/admin/moderation/targets/{type}/{id}/dismiss", 200);
  });

  /** A published free course whose owner is `owner`, with one members-only article lesson. */
  async function publishedFreeCourse(owner: Session) {
    const res = await post("/v1/studio/courses", { title: `Contract ${uniq()}`, description: "A course", categoryId, language: "en", pricePaise: "0" }, owner);
    expect(res.status).toBe(201);
    const section = await prisma.courseSection.create({ data: { courseId: res.body.id, title: "S", position: 0 } });
    const lesson = await prisma.lesson.create({ data: { courseId: res.body.id, sectionId: section.id, title: "Members", type: "ARTICLE", position: 0, articleBody: "t" } });
    await prisma.course.update({ where: { id: res.body.id }, data: { status: "PUBLISHED", publishedAt: new Date(), slugLockedAt: new Date() } });
    return { id: res.body.id as string, slug: res.body.slug as string, lessonId: lesson.id };
  }
  async function enrol(slug: string): Promise<Session> {
    const s = await t.login();
    expect((await http().post(`/v1/courses/${slug}/enrol`).set(auth(s))).status).toBe(201);
    return s;
  }

  it("course review queue: approve, reject, flag and unflag", async () => {
    const fx = fixtures();
    const owner = await fx.creator();
    await givePlan(prisma, "USER", owner.userId, "business");
    const toApprove = await fx.completeCourse(owner);
    const toReject = await fx.completeCourse(owner);
    await fx.inReview(toApprove.id);
    await fx.inReview(toReject.id);

    const queue = declared(await get("/v1/admin/courses/review-queue?limit=100"), "GET /v1/admin/courses/review-queue", 200);
    expect(queue.body.items.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining([toApprove.id, toReject.id]));
    const approved = declared(await post(`/v1/admin/courses/${toApprove.id}/approve`), "POST /v1/admin/courses/{id}/approve", 200);
    expect(approved.body.status).toBe("PUBLISHED");
    const rejected = declared(await post(`/v1/admin/courses/${toReject.id}/reject`, { reason: "Needs a better description" }), "POST /v1/admin/courses/{id}/reject", 200);
    expect(rejected.body).toMatchObject({ status: "DRAFT", rejectionReason: "Needs a better description" });
    const flagged = declared(await post(`/v1/admin/courses/${toApprove.id}/flag`, { reason: "Misleading" }), "POST /v1/admin/courses/{id}/flag", 200);
    expect(flagged.body.flagReason).toBe("Misleading");
    expect(declared(await post(`/v1/admin/courses/${toApprove.id}/unflag`, { reason: "Fixed" }), "POST /v1/admin/courses/{id}/unflag", 200).body.flaggedAt).toBeNull();
  });

  it("content hides: reviews, questions and answers", async () => {
    const owner = await fixtures().creator();
    const c = await publishedFreeCourse(owner);
    const learner = await enrol(c.slug);
    const review = await http().put(`/v1/courses/${c.slug}/reviews/mine`).set(auth(learner)).send({ rating: 3, body: "ok" });
    expect(review.status).toBe(200);
    const question = await post(`/v1/learn/lessons/${c.lessonId}/questions`, { body: "How does this work?" }, learner);
    expect(question.status).toBe(201);
    const answer = await post(`/v1/learn/questions/${question.body.id}/answers`, { body: "Like so." }, learner);
    expect(answer.status).toBe(201);

    for (const [kind, id] of [["reviews", review.body.id], ["questions", question.body.id], ["answers", answer.body.id]] as const) {
      const hidden = declared(await post(`/v1/admin/${kind}/${id}/hide`, { reason: "Off topic" }), `POST /v1/admin/${kind}/{id}/hide`, 200);
      expect(hidden.body).toEqual({ id, hidden: true });
      const shown = declared(await post(`/v1/admin/${kind}/${id}/unhide`, { reason: "Fine after all" }), `POST /v1/admin/${kind}/{id}/unhide`, 200);
      expect(shown.body).toEqual({ id, hidden: false });
    }
  });

  it("course categories", async () => {
    const created = declared(await post("/v1/admin/course-categories", { name: `Contract ${uniq()}`, position: 900 }), "POST /v1/admin/course-categories", 201);
    made.categories.push(created.body.id);
    const list = declared(await get("/v1/admin/course-categories"), "GET /v1/admin/course-categories", 200);
    expect(list.body.items.map((c: { id: string }) => c.id)).toContain(created.body.id);
    const updated = declared(await http().patch(`/v1/admin/course-categories/${created.body.id}`).set(auth(admin)).send({ isActive: false, position: 901 }), "PATCH /v1/admin/course-categories/{id}", 200);
    expect(updated.body).toMatchObject({ isActive: false, position: 901 });
    noContent(await http().delete(`/v1/admin/course-categories/${created.body.id}`).set(auth(admin)), "DELETE /v1/admin/course-categories/{id}");
  });

  it("campaigns: create, edit, preview, test send, approve, send, pause, resume, cancel", async () => {
    const tag = `tag:ct${uniq()}`;
    const body = (over: Record<string, unknown> = {}) => ({ name: `Contract ${uniq()}`, subject: "Big news", bodyMarkdown: "Hello **there**.", segment: { interests: [tag], lastActive: { withinDays: 30 }, hasPurchased: false }, ...over });
    const c = declared(await post("/v1/admin/campaigns", body()), "POST /v1/admin/campaigns", 201);
    expect(c.body).toMatchObject({ status: "DRAFT", audienceSize: null, approvedById: null, stats: { delivered: 0, unknown: 0 } });
    const plainSegment = declared(await post("/v1/admin/campaigns", body({ segment: { interests: [tag], lastActive: { inactiveDays: 90 } } })), "POST /v1/admin/campaigns", 201);
    expect(plainSegment.body.segment).toEqual({ interests: [tag], lastActive: { inactiveDays: 90 } });

    const skipped = await t.login();
    await prisma.campaignRecipient.create({ data: { campaignId: c.body.id, userId: skipped.userId, status: "SKIPPED", skipReason: "unsubscribed" } });
    const listed = declared(await get("/v1/admin/campaigns?status=DRAFT&limit=100"), "GET /v1/admin/campaigns", 200);
    expect(listed.body.items.map((x: { id: string }) => x.id)).toContain(c.body.id);
    declared(await get("/v1/admin/campaigns"), "GET /v1/admin/campaigns", 200);
    const detail = declared(await get(`/v1/admin/campaigns/${c.body.id}`), "GET /v1/admin/campaigns/{id}", 200);
    expect(detail.body).toMatchObject({ recipients: { SKIPPED: 1 }, skipped: { unsubscribed: 1 } });

    declared(await http().patch(`/v1/admin/campaigns/${c.body.id}`).set(auth(admin)).send({ subject: "Bigger news", segment: { interests: [tag] } }), "PATCH /v1/admin/campaigns/{id}", 200);
    expect(declared(await post(`/v1/admin/campaigns/${c.body.id}/preview`), "POST /v1/admin/campaigns/{id}/preview", 200).body).toEqual({ audience: 0, requiresApproval: false });
    const before = t.mail.sent.length;
    expect(declared(await post(`/v1/admin/campaigns/${c.body.id}/test-send`), "POST /v1/admin/campaigns/{id}/test-send", 200).body).toEqual({ sent: true });
    expect(t.mail.sent.length).toBeGreaterThanOrEqual(before);

    // Approval is by someone else than the creator and the last editor.
    const approved = declared(await post(`/v1/admin/campaigns/${c.body.id}/approve`, {}, second), "POST /v1/admin/campaigns/{id}/approve", 200);
    expect(approved.body.approvedById).toBe(second.userId);
    const sent = declared(await post(`/v1/admin/campaigns/${c.body.id}/send`), "POST /v1/admin/campaigns/{id}/send", 200);
    expect(sent.body.status).toBe("SCHEDULED");
    expect(sent.body.scheduledAt).toEqual(expect.any(String));
    const cancelled = declared(await post(`/v1/admin/campaigns/${c.body.id}/cancel`), "POST /v1/admin/campaigns/{id}/cancel", 200);
    expect(cancelled.body.status).toBe("CANCELLED");

    // Pause and resume apply to a campaign that is sending: put one there directly (no sender runs in this suite).
    await prisma.campaign.update({ where: { id: plainSegment.body.id }, data: { status: "SENDING", startedAt: new Date(), audienceSize: 0 } });
    expect(declared(await post(`/v1/admin/campaigns/${plainSegment.body.id}/pause`), "POST /v1/admin/campaigns/{id}/pause", 200).body.status).toBe("PAUSED");
    const resumed = declared(await post(`/v1/admin/campaigns/${plainSegment.body.id}/resume`), "POST /v1/admin/campaigns/{id}/resume", 200);
    expect(resumed.body).toMatchObject({ status: "SENDING", audienceSize: 0, startedAt: expect.any(String) });
    declared(await post(`/v1/admin/campaigns/${plainSegment.body.id}/cancel`), "POST /v1/admin/campaigns/{id}/cancel", 200);
  });

  it("analytics: overview, series, funnel, CSV export and rebuild", async () => {
    const overview = declared(await get("/v1/admin/analytics/overview?from=2001-03-01&to=2001-03-10"), "GET /v1/admin/analytics/overview", 200);
    expect(overview.body.metrics.length).toBeGreaterThan(20);
    declared(await get("/v1/admin/analytics/overview"), "GET /v1/admin/analytics/overview", 200);
    const series = declared(await get("/v1/admin/analytics/series?keys=signups,gmv_paise&from=2001-03-01&to=2001-03-03"), "GET /v1/admin/analytics/series", 200);
    expect(series.body.points).toHaveLength(3);
    expect(series.body.points[0].values).toEqual({ signups: 0, gmv_paise: "0" });
    const funnel = declared(await get("/v1/admin/analytics/funnel?from=2001-03-01&to=2001-03-03"), "GET /v1/admin/analytics/funnel", 200);
    expect(funnel.body.stages).toHaveLength(4);

    const csv = await get("/v1/admin/analytics/export?keys=signups,gmv_paise&from=2001-03-01&to=2001-03-03");
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toBe('attachment; filename="skiller-analytics-2001-03-01_2001-03-03.csv"');
    expect(csv.text).toBe("day,signups,gmv_paise\r\n2001-03-01,0,0\r\n2001-03-02,0,0\r\n2001-03-03,0,0\r\n");
    const op = openapi().paths["/v1/admin/analytics/export"].get.responses["200"];
    expect(op.content).toEqual({ "text/csv": { schema: expect.objectContaining({ type: "string" }) } });
    seen.add("GET /v1/admin/analytics/export");

    const rebuild = declared(await post("/v1/admin/analytics/rebuild", { from: "2001-03-04", to: "2001-03-05" }), "POST /v1/admin/analytics/rebuild", 202);
    expect(rebuild.body).toMatchObject({ from: "2001-03-04", to: "2001-03-05" });
  });

  it("payout accounts held for review, plans and subscriptions", async () => {
    const owner = await t.login();
    const account = (over: Record<string, unknown>, ownerId = owner.userId) =>
      prisma.payoutAccount.create({
        data: {
          ownerType: "USER",
          ownerId,
          type: "BANK",
          status: "VERIFIED",
          holderName: "Test Holder",
          ifsc: "HDFC0000001",
          accountLast4: "1234",
          panLast4: "234F",
          panHash: uniq(),
          razorpayxContactId: `cont_${uniq()}`,
          razorpayxFundAccountId: `fa_${uniq()}`,
          cooldownUntil: new Date(),
          createdBy: owner.userId,
          ...over,
        } as never,
      });
    const flagged = await account({ reviewFlag: "DUPLICATE_PAN", panNameMatch: false });
    await account({ type: "UPI", ifsc: null, accountLast4: null, vpaMasked: "t***@upi", status: "PENDING" }, (await t.login()).userId);
    const list = declared(await get("/v1/admin/payout-accounts?flagged=true&limit=100"), "GET /v1/admin/payout-accounts", 200);
    expect(list.body.items.find((a: { id: string }) => a.id === flagged.id)).toMatchObject({ ownerId: owner.userId, reviewFlag: "DUPLICATE_PAN", underReview: true });
    const all = declared(await get(`/v1/admin/payout-accounts?status=PENDING&limit=100`), "GET /v1/admin/payout-accounts", 200);
    expect(all.body.items.some((a: { vpaMasked: string | null }) => a.vpaMasked === "t***@upi")).toBe(true);
    const cleared = declared(await post(`/v1/admin/payout-accounts/${flagged.id}/clear-flag`, { flag: "DUPLICATE_PAN", note: "checked" }), "POST /v1/admin/payout-accounts/{id}/clear-flag", 200);
    expect(cleared.body).toMatchObject({ id: flagged.id, reviewFlag: null, underReview: false });

    const plan = declared(await post("/v1/admin/plans", { key: `ct_${uniq()}`, name: "Contract plan", audience: "CREATOR", version: { pricePaise: "49900", interval: "MONTH", commissionBps: 900, limits: LIMITS } }), "POST /v1/admin/plans", 201);
    made.plans.push(plan.body.id);
    expect(plan.body.versions).toHaveLength(1);
    const version = declared(await post(`/v1/admin/plans/${plan.body.id}/versions`, { pricePaise: "59900", interval: "YEAR", commissionBps: 800, limits: LIMITS }), "POST /v1/admin/plans/{id}/versions", 201);
    expect(version.body).toMatchObject({ planId: plan.body.id, pricePaise: "59900", currency: "INR" });

    await givePlan(prisma, "USER", owner.userId, "pro");
    const subs = declared(await get(`/v1/admin/subscriptions?ownerType=USER&ownerId=${owner.userId}`), "GET /v1/admin/subscriptions", 200);
    expect(subs.body.items[0]).toMatchObject({ ownerId: owner.userId, status: "ACTIVE", plan: { key: "pro" } });
    declared(await get("/v1/admin/subscriptions?limit=100"), "GET /v1/admin/subscriptions", 200);
  });

  it("every route that used to be untyped is now declared with a response, and was exercised above", () => {
    const doc = openapi();
    const unexercised = ROUTES.filter((r) => !seen.has(r));
    expect(unexercised).toEqual([]);
    for (const route of ROUTES) {
      const [method, path] = route.split(" ");
      const responses = doc.paths[path]?.[method.toLowerCase()]?.responses ?? {};
      const ok = Object.entries(responses).filter(([status]) => /^2\d\d$/.test(status));
      expect([route, ok.length]).toEqual([route, 1]);
    }
    expect(ROUTES).toHaveLength(57);
  });
});
