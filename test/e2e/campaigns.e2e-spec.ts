import { randomUUID } from "node:crypto";
import type { Job, Queue } from "bullmq";
import request from "supertest";
import { Webhook } from "svix";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { SettingsService } from "../../src/modules/admin";
import { QueueWorkerRunner } from "../../src/common/queue/queue-worker.runner";
import { QueueNames, queueToken } from "../../src/common/queue/queue.constants";
import { PROMO_JOB_OPTIONS } from "../../src/common/queue/queue.options";
import { CampaignSender, PromoMailProcessor, UnsubscribeTokens } from "../../src/modules/growth";
import { PromoPreferences } from "../../src/modules/notifications";
import { RolesService } from "../../src/modules/rbac";
import { givePlan } from "../support/billing";
import { until } from "../support/payouts";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);
const WEBHOOK_SECRET = "whsec_dGVzdHNlY3JldA==";

describe("promo email campaigns", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let sender: CampaignSender;
  let admin: Session;
  let second: Session;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const bulkEmailPrefix = `bulk-${uniq()}`;

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

  /** `n` active users who all carry one fresh interest key: the segment `{ interests: [key] }` is exactly them. */
  async function audience(n: number, prefix = "aud") {
    const tag = `t${uniq()}`;
    const stamp = uniq();
    await prisma.user.createMany({ data: Array.from({ length: n }, (_, i) => ({ email: `${prefix}-${stamp}-${i}@example.com`, status: "ACTIVE" as const })) });
    const users = await prisma.user.findMany({ where: { email: { startsWith: `${prefix}-${stamp}-` } }, orderBy: { email: "asc" } });
    await prisma.userInterest.createMany({ data: users.map((u) => ({ userId: u.id, key: `tag:${tag}`, weight: 5, updatedAt: new Date() })) });
    return { tag, key: `tag:${tag}`, users, segment: { interests: [`tag:${tag}`] } };
  }
  const campaignBody = (over: Record<string, unknown> = {}) => ({ name: `Campaign ${uniq()}`, subject: "Big news from Skiller", bodyMarkdown: "Hello **there**. [Browse](https://skiller.test/courses)", segment: {}, ...over });
  const create = (body: Record<string, unknown> = {}, s: Session = admin) => http().post("/v1/admin/campaigns").set(auth(s)).send(campaignBody(body));
  async function made(body: Record<string, unknown> = {}) {
    const res = await create(body);
    expect(res.status).toBe(201);
    return res.body as { id: string; status: string };
  }
  const act = (id: string, verb: string, body: Record<string, unknown> = {}, s: Session = admin) => http().post(`/v1/admin/campaigns/${id}/${verb}`).set(auth(s)).send(body);
  const sentTo = (emails: string[]) => t.mail.sent.filter((m) => emails.includes(m.to));
  const recipients = (id: string) => prisma.campaignRecipient.findMany({ where: { campaignId: id }, orderBy: { userId: "asc" } });
  /** Sends a campaign (approval permitting) and runs the sender until it is done. */
  async function launch(id: string) {
    const res = await act(id, "send");
    expect(res.status).toBe(200);
    await sender.tick();
  }
  const tokenFrom = (header: string | undefined) => new URL(/<([^>]+)>/.exec(header ?? "")![1]).searchParams.get("t")!;

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    sender = t.app.get(CampaignSender);
    admin = await superAdmin();
    second = await superAdmin();
  });
  /** Step-up lasts five minutes; this suite runs longer, so it is renewed when it gets old. */
  let steppedAt = Date.now();
  beforeEach(async () => {
    if (Date.now() - steppedAt < 120_000) return;
    await stepUp(admin);
    await stepUp(second);
    steppedAt = Date.now();
  });
  afterAll(async () => {
    await prisma.userInterest.deleteMany({ where: { userId: { in: (await prisma.user.findMany({ where: { email: { startsWith: bulkEmailPrefix } }, select: { id: true } })).map((u) => u.id) } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: bulkEmailPrefix } } });
    await t?.close();
  });

  describe("access and content", () => {
    it("needs campaign.manage and a step-up for every change; plain members and anonymous callers are refused", async () => {
      const member = await t.login();
      const plain = await t.login();
      await t.app.get(RolesService).grantSystem(plain.userId, "moderator");
      for (const s of [member, plain]) {
        expect((await http().get("/v1/admin/campaigns").set(auth(s))).status).toBe(403);
        expect((await create({}, s)).status).toBe(403);
      }
      expect((await http().get("/v1/admin/campaigns")).status).toBe(401);
      const noStepUp = await t.login();
      await t.app.get(RolesService).grantSystem(noStepUp.userId, "super_admin");
      const res = await create({}, noStepUp);
      expect([res.status, res.body.error.code]).toEqual([403, "STEP_UP_REQUIRED"]);
      expect((await http().get("/v1/admin/campaigns").set(auth(noStepUp))).status).toBe(200); // reading needs no step-up
    });

    it("creates a draft; subject is plain text up to 150, the body is safe Markdown, the segment is checked", async () => {
      const ok = await create({ segment: { roles: ["creator"], plan: ["pro"], interests: ["tag:python"], lastActive: { withinDays: 30 }, hasPurchased: true } });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ status: "DRAFT", createdById: admin.userId, approvedById: null, scheduledAt: null });
      expect(await prisma.auditLog.count({ where: { action: "campaign.create", targetId: ok.body.id } })).toBe(1);
      const bad = async (over: Record<string, unknown>) => create(over);
      expect((await bad({ subject: "x".repeat(151) })).status).toBe(400);
      expect((await bad({ subject: "two\nlines" })).status).toBe(400);
      expect((await bad({ subject: "   " })).status).toBe(400);
      expect((await create({ subject: "x".repeat(150) })).status).toBe(201);
      const html = await bad({ bodyMarkdown: "hi <script>alert(1)</script>" });
      expect([html.status, html.body.error.code]).toEqual([422, "MARKDOWN_UNSAFE"]);
      expect((await bad({ bodyMarkdown: "[x](javascript:alert(1))" })).body.error.code).toBe("MARKDOWN_UNSAFE");
      for (const segment of [{ roles: "creator" }, { unknown: true }, { lastActive: {} }, { lastActive: { withinDays: 0 } }, { plan: Array.from({ length: 21 }, (_, i) => `p${i}`) }, { hasPurchased: "yes" }]) {
        expect([JSON.stringify(segment), (await bad({ segment })).status]).toEqual([JSON.stringify(segment), 400]);
      }
      const patch = await http().patch(`/v1/admin/campaigns/${ok.body.id}`).set(auth(admin)).send({ subject: "Changed", segment: {} });
      expect([patch.status, patch.body.subject]).toEqual([200, "Changed"]);
      expect((await http().get(`/v1/admin/campaigns/${ok.body.id}`).set(auth(admin))).body.id).toBe(ok.body.id);
      expect((await http().get("/v1/admin/campaigns").set(auth(admin))).body.items.length).toBeGreaterThan(0);
    });
  });

  describe("segments, preview and test send (Review Focus 3)", () => {
    it("each criterion filters the audience; criteria combine with AND, values within one with OR", async () => {
      const a = await audience(6);
      const [creator, pro, buyer, active, stale, plain] = a.users;
      await t.app.get(RolesService).grantSystem(creator.id, "creator");
      await givePlan(prisma, "USER", pro.id, "pro");
      const planVersion = await prisma.planVersion.findFirstOrThrow();
      await prisma.order.create({ data: { buyerId: buyer.id, status: "PAID", listPricePaise: 100n, totalPaise: 100n, sellerOwnerType: "USER", sellerOwnerId: plain.id, commissionBps: 0, gstBps: 0, planVersionId: planVersion.id, paidAt: new Date() } });
      const session = (userId: string, lastUsedAt: Date) => prisma.session.create({ data: { userId, familyId: randomUUID(), refreshHash: randomUUID(), userAgent: "t", ip: "1.1.1.1", lastUsedAt, expiresAt: new Date(Date.now() + 1e9) } });
      await session(active.id, t.clock.now());
      await session(stale.id, new Date(t.clock.now().getTime() - 90 * 86400_000));
      const count = async (segment: Record<string, unknown>) => {
        const c = await made({ segment: { ...a.segment, ...segment } });
        const res = await act(c.id, "preview");
        expect(res.status).toBe(200);
        return res.body.audience as number;
      };
      expect(await count({})).toBe(6);
      expect(await count({ roles: ["creator"] })).toBe(1);
      expect(await count({ roles: ["creator", "moderator"] })).toBe(1);
      expect(await count({ plan: ["pro"] })).toBe(1);
      expect(await count({ plan: ["free"] })).toBe(5); // no paid subscription = free
      expect(await count({ plan: ["free", "pro"] })).toBe(6);
      expect(await count({ hasPurchased: true })).toBe(1);
      expect(await count({ hasPurchased: false })).toBe(5);
      expect(await count({ lastActive: { withinDays: 30 } })).toBe(1);
      expect(await count({ lastActive: { inactiveDays: 30 } })).toBe(5); // stale + never seen
      expect(await count({ roles: ["creator"], plan: ["pro"] })).toBe(0);
      expect(await count({ interests: ["tag:nobody-has-this"] })).toBe(0);
      // a suspended account is never in the audience
      await prisma.user.update({ where: { id: plain.id }, data: { status: "SUSPENDED" } });
      expect(await count({})).toBe(5);
    });

    it("preview returns counts only; the test send goes to the acting admin and nowhere else", async () => {
      const a = await audience(3);
      const c = await made({ segment: a.segment, subject: "Preview me" });
      const preview = await act(c.id, "preview");
      expect(Object.keys(preview.body).sort()).toEqual(["audience", "requiresApproval"]);
      expect(preview.body).toEqual({ audience: 3, requiresApproval: false });
      for (const u of a.users) expect(JSON.stringify(preview.body)).not.toContain(u.email);

      const before = t.mail.sent.length;
      const test = await act(c.id, "test-send", { to: "someone-else@example.com", userId: a.users[0].id });
      expect(test.status).toBe(200);
      expect(test.body).toEqual({ sent: true });
      await until(async () => t.mail.sent.length > before);
      const mails = t.mail.sent.slice(before).filter((m) => m.subject.includes("Preview me"));
      expect(mails.map((m) => m.to)).toEqual([admin.email]);
      expect(mails[0].subject).toMatch(/^\[Test\]/);
      expect(sentTo(a.users.map((u) => u.email))).toHaveLength(0);
      expect((await recipients(c.id))).toHaveLength(0); // nothing materialised by a preview or a test
      const view = await http().get(`/v1/admin/campaigns/${c.id}`).set(auth(admin));
      expect(JSON.stringify(view.body)).not.toContain(a.users[0].email); // the admin view of a campaign carries no member data
    });
  });

  describe("sending", () => {
    const promoQueue = () => t.app.get<Queue>(queueToken(QueueNames.mailPromo));
    const depth = async () => Object.values(await promoQueue().getJobCounts("waiting", "delayed", "active", "prioritized")).reduce((a, b) => a + b, 0);
    /** Holds the promo mail worker (jobs pile up in Redis) so a test can act between "queued" and "sent"; the queue is always released afterwards. */
    const hold = () => promoQueue().pause();
    const release = () => promoQueue().resume();
    const drained = () => until(async () => (await depth()) === 0, 30_000);
    const row = (id: string, userId: string) => prisma.campaignRecipient.findUniqueOrThrow({ where: { campaignId_userId: { campaignId: id, userId } } });
    const byStatus = async (id: string) => {
      const out: Record<string, number> = {};
      for (const r of await recipients(id)) out[r.status] = (out[r.status] ?? 0) + 1;
      return out;
    };
    /** Ticks the sender until the campaign is SENT: a mail still queued keeps it SENDING. */
    const finish = (id: string, ms = 30_000) =>
      until(async () => {
        await sender.tick();
        const c = await prisma.campaign.findUniqueOrThrow({ where: { id } });
        return c.status === "SENT" ? c : null;
      }, ms);
    const setRate = async (perSecond: number) => {
      await t.app.get(SettingsService).set(admin.userId, "promo_send_per_second", perSecond, {});
      await t.app.get(QueueWorkerRunner).refreshLimiters();
    };
    const fakeJob = (campaignId: string, userId: string) => ({ id: `campaign-${campaignId}-${userId}`, name: "send", data: { campaignId, userId }, attemptsMade: 0, opts: { attempts: 8 } }) as unknown as Job;

    beforeAll(() => setRate(500));
    afterEach(async () => {
      t.mail.failWith(null);
      t.mail.delayMs = 0;
      await release();
    });
    afterAll(() => setRate(8));

    it("sends once per member with the unsubscribe footer and one-click headers; the footer cannot be written out of the body", async () => {
      const a = await audience(3);
      const c = await made({ segment: a.segment, subject: "Spring sale", bodyMarkdown: "No footer please." });
      const send = await act(c.id, "send");
      expect([send.status, send.body.status]).toEqual([200, "SCHEDULED"]);
      expect(await prisma.auditLog.count({ where: { action: "campaign.send", targetId: c.id } })).toBe(1);
      await sender.tick();
      const emails = a.users.map((u) => u.email);
      await until(async () => sentTo(emails).length === 3);
      await finish(c.id);
      for (const m of sentTo(emails)) {
        const url = new URL(/<([^>]+)>/.exec(m.headers!["List-Unsubscribe"])![1]);
        expect(m.subject).toBe("Spring sale");
        expect(m.html).toContain("You are receiving this promotional email");
        expect(m.text).toContain("You are receiving this promotional email");
        expect(m.html).toContain(`href="${url.href.replace(/&/g, "&amp;")}"`);
        expect(m.text).toContain(url.href);
        expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
        expect(m.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/app\.skiller\.test\/v1\/unsubscribe\?t=[^>]+>$/);
        expect(m.idempotencyKey).toContain(c.id);
      }
      await until(async () => (await recipients(c.id)).every((r) => r.status === "SENT" && r.resendId));
      // running the sender again sends nothing more
      await sender.tick();
      await new Promise((r) => setTimeout(r, 300));
      expect(sentTo(emails)).toHaveLength(3);
    });

    it("skips, with a reason, suppressed addresses, unsubscribed members, suspended accounts and (when required) members without marketing opt-in", async () => {
      const a = await audience(6);
      const [ok, suppressed, off, suspended, optedIn, plainMember] = a.users;
      await prisma.emailSuppression.create({ data: { email: suppressed.email, reason: "bounced" } });
      await prisma.notificationPreference.create({ data: { userId: off.id, type: "promo", inApp: true, email: false } });
      await prisma.user.update({ where: { id: suspended.id }, data: { status: "SUSPENDED" } });
      await prisma.notificationPreference.create({ data: { userId: optedIn.id, type: "marketing_opt_in", inApp: true, email: true } });
      const c = await made({ segment: a.segment });
      // the suspended member is not in the audience, so they are never even a recipient
      await launch(c.id);
      await until(async () => (await recipients(c.id)).filter((r) => r.status === "SENT").length === 3);
      const byUser = new Map((await recipients(c.id)).map((r) => [r.userId, r]));
      expect(byUser.has(suspended.id)).toBe(false);
      expect(byUser.get(suppressed.id)).toMatchObject({ status: "SKIPPED", skipReason: "suppressed" });
      expect(byUser.get(off.id)).toMatchObject({ status: "SKIPPED", skipReason: "unsubscribed" });
      for (const u of [ok, optedIn, plainMember]) expect(byUser.get(u.id)?.status).toBe("SENT");
      expect(sentTo([suppressed.email, off.email, suspended.email])).toHaveLength(0);

      // explicit opt-in mode: only members who opted in
      const settings = t.app.get(SettingsService);
      await settings.set(admin.userId, "marketing_opt_in_required", true, {});
      try {
        const b = await audience(3);
        await prisma.notificationPreference.create({ data: { userId: b.users[0].id, type: "marketing_opt_in", inApp: true, email: true } });
        const c2 = await made({ segment: b.segment });
        await launch(c2.id);
        await until(async () => (await recipients(c2.id)).every((r) => r.status !== "PENDING" && r.status !== "SENDING"));
        const rows = new Map((await recipients(c2.id)).map((r) => [r.userId, r]));
        expect(rows.get(b.users[0].id)?.status).toBe("SENT");
        expect(rows.get(b.users[1].id)).toMatchObject({ status: "SKIPPED", skipReason: "marketing_opt_in_required" });
        expect(rows.get(b.users[2].id)).toMatchObject({ status: "SKIPPED", skipReason: "marketing_opt_in_required" });
        expect(sentTo([b.users[1].email, b.users[2].email])).toHaveLength(0);
      } finally {
        await settings.set(admin.userId, "marketing_opt_in_required", false, {});
      }
    });

    describe("campaign mail never competes with transactional mail (C1)", () => {
      it("an OTP is delivered promptly while a large campaign is still draining; the campaign has its own queue and limit", async () => {
        const a = await audience(60);
        const emails = a.users.map((u) => u.email);
        await setRate(10);
        t.mail.delayMs = 100; // a slow Resend: the campaign needs 6 s or more
        try {
          const c = await made({ segment: a.segment });
          await launch(c.id);
          await until(async () => sentTo(emails).length >= 3);
          const started = Date.now();
          const member = await t.login(); // email OTP: request, mail, verify
          expect(Date.now() - started).toBeLessThan(4000);
          expect(sentTo(emails).length).toBeLessThan(60); // the campaign was still draining when the code arrived
          expect(await depth()).toBeGreaterThan(0);
          expect(member.userId).toBeTruthy();
          // the transactional queue never carried a campaign mail
          const transactional = await t.app.get<Queue>(queueToken(QueueNames.mail)).getJobs(["waiting", "active", "delayed", "completed", "failed"]);
          expect(transactional.filter((j) => j.data.template === "promo_campaign" && emails.includes(j.data.to))).toHaveLength(0);
          await finish(c.id, 60_000);
        } finally {
          await setRate(500);
        }
      }, 90_000);

      it("promo mail is rate limited by the promo_send_per_second setting", async () => {
        const a = await audience(18);
        const emails = a.users.map((u) => u.email);
        await setRate(6);
        try {
          const c = await made({ segment: a.segment });
          const t0 = Date.now();
          await launch(c.id);
          await until(async () => sentTo(emails).length === 18);
          // 18 mails at 6 a second cannot be out in under two windows
          expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);
          await finish(c.id);
        } finally {
          await setRate(500);
        }
      }, 60_000);

      it("the sender stops queueing at 500 waiting mails (backpressure) and carries on as the queue drains", async () => {
        await hold();
        const a = await audience(600, bulkEmailPrefix);
        const c = await made({ segment: a.segment });
        expect((await act(c.id, "send")).status).toBe(200);
        await sender.start(c.id);
        for (let i = 0; i < 3; i++) await sender.run(c.id, { maxBatches: 10 });
        expect(await depth()).toBe(500);
        expect(await byStatus(c.id)).toEqual({ SENDING: 500, PENDING: 100 });
        await sender.run(c.id, { maxBatches: 10 });
        expect(await depth()).toBe(500); // still full: nothing more is queued
        await release();
        await drained();
        await finish(c.id, 60_000);
        expect(await byStatus(c.id)).toEqual({ SENT: 600 });
        expect(sentTo(a.users.map((u) => u.email))).toHaveLength(600);
      }, 120_000);

      it("a queued mail carries only {campaignId, userId}: no body, subject, address or link", async () => {
        await hold();
        const a = await audience(3);
        const c = await made({ segment: a.segment, subject: "Quiet subject", bodyMarkdown: "A secret body that must not sit in Redis." });
        await launch(c.id);
        const jobs = await promoQueue().getJobs(["waiting", "delayed", "prioritized"]);
        const mine = jobs.filter((j) => j.data.campaignId === c.id);
        expect(mine).toHaveLength(3);
        for (const j of mine) {
          expect(Object.keys(j.data).sort()).toEqual(["campaignId", "userId"]);
          const raw = JSON.stringify(j.data);
          for (const leak of ["secret body", "Quiet subject", "@example.com", "unsubscribe"]) expect(raw).not.toContain(leak);
        }
        await release();
        await finish(c.id);
        expect(sentTo(a.users.map((u) => u.email))).toHaveLength(3);
      });
    });

    describe("what happens to mail already queued (I2)", () => {
      it("works in batches of 100; pause and resume act between batches, and cancel stops every mail not yet sent", async () => {
        await hold();
        const a = await audience(250, bulkEmailPrefix);
        const emails = a.users.map((u) => u.email);
        const c = await made({ segment: a.segment });
        expect((await act(c.id, "send")).status).toBe(200);
        // approval is needed above 10,000 only; 250 goes straight through. The tick starts it (writes the recipients); one batch = 100 recipients.
        await sender.start(c.id);
        await sender.run(c.id, { maxBatches: 1 });
        const moved = async () => (await recipients(c.id)).filter((r) => r.status !== "PENDING").length;
        expect(await moved()).toBe(100);
        expect(await depth()).toBe(100);
        expect((await act(c.id, "pause")).body.status).toBe("PAUSED");
        await sender.run(c.id, { maxBatches: 5 });
        expect(await moved()).toBe(100); // paused: nothing moves
        expect((await act(c.id, "resume")).body.status).toBe("SENDING");
        await sender.run(c.id, { maxBatches: 1 });
        expect(await moved()).toBe(200);
        const cancel = await act(c.id, "cancel");
        expect([cancel.status, cancel.body.status]).toEqual([200, "CANCELLED"]);
        await sender.run(c.id, { maxBatches: 5 });
        expect((await recipients(c.id)).filter((r) => r.status === "SKIPPED" && r.skipReason === "cancelled")).toHaveLength(50);
        // the 200 mails already queued are dropped by the worker, not sent
        await release();
        await drained();
        await until(async () => (await recipients(c.id)).every((r) => r.status === "SKIPPED"));
        expect((await recipients(c.id)).every((r) => r.skipReason === "cancelled")).toBe(true);
        expect(sentTo(emails)).toHaveLength(0);
        expect((await act(c.id, "resume")).status).toBe(409);
        for (const action of ["campaign.pause", "campaign.resume", "campaign.cancel"]) expect(await prisma.auditLog.count({ where: { action, targetId: c.id } })).toBe(1);
      });

      it("pause stops mail that is already queued, and resume sends it, once", async () => {
        await hold();
        const a = await audience(5);
        const emails = a.users.map((u) => u.email);
        const c = await made({ segment: a.segment });
        await launch(c.id);
        expect(await depth()).toBe(5);
        expect(sentTo(emails)).toHaveLength(0);
        expect((await act(c.id, "pause")).body.status).toBe("PAUSED");
        await release();
        await drained();
        await new Promise((r) => setTimeout(r, 300));
        expect(sentTo(emails)).toHaveLength(0);
        expect(await byStatus(c.id)).toEqual({ PENDING: 5 }); // released back, not lost
        expect((await act(c.id, "resume")).body.status).toBe("SENDING");
        await finish(c.id);
        for (const e of emails) expect(sentTo([e])).toHaveLength(1);
        expect(await byStatus(c.id)).toEqual({ SENT: 5 });
      });

      it("a member who opts out, or is suppressed, after their mail was queued is skipped, not mailed", async () => {
        await hold();
        const a = await audience(4);
        const [stays, leaves, bounced, alsoStays] = a.users;
        const c = await made({ segment: a.segment });
        await launch(c.id);
        expect(await depth()).toBe(4);
        await t.app.get(PromoPreferences).setPromoEmail(leaves.id, false);
        await prisma.emailSuppression.create({ data: { email: bounced.email, reason: "bounced" } });
        await release();
        await finish(c.id);
        // unsubscribing also suppresses the address, so either reason names it
        expect(await row(c.id, leaves.id)).toMatchObject({ status: "SKIPPED", skipReason: expect.stringMatching(/^(suppressed|unsubscribed)$/) });
        expect(await row(c.id, bounced.id)).toMatchObject({ status: "SKIPPED", skipReason: "suppressed" });
        expect(sentTo([leaves.email, bounced.email])).toHaveLength(0);
        expect(sentTo([stays.email, alsoStays.email])).toHaveLength(2);
      });

      it("turning marketing_opt_in_required on after queueing stops the mail of members who never opted in", async () => {
        await hold();
        const a = await audience(3);
        const [opted, never1, never2] = a.users;
        await prisma.notificationPreference.create({ data: { userId: opted.id, type: "marketing_opt_in", inApp: true, email: true } });
        const c = await made({ segment: a.segment });
        await launch(c.id);
        const settings = t.app.get(SettingsService);
        await settings.set(admin.userId, "marketing_opt_in_required", true, {});
        try {
          await release();
          await finish(c.id);
        } finally {
          await settings.set(admin.userId, "marketing_opt_in_required", false, {});
        }
        expect(await row(c.id, never1.id)).toMatchObject({ status: "SKIPPED", skipReason: "marketing_opt_in_required" });
        expect(await row(c.id, never2.id)).toMatchObject({ status: "SKIPPED", skipReason: "marketing_opt_in_required" });
        expect(sentTo([never1.email, never2.email])).toHaveLength(0);
        expect(sentTo([opted.email])).toHaveLength(1);
      });
    });

    describe("failures (I4)", () => {
      /** Retries in a test take milliseconds, not minutes. */
      const quickRetries = (attempts: number) => {
        const saved = { attempts: PROMO_JOB_OPTIONS.attempts, backoff: PROMO_JOB_OPTIONS.backoff };
        PROMO_JOB_OPTIONS.attempts = attempts;
        PROMO_JOB_OPTIONS.backoff = { type: "fixed", delay: 30 };
        return () => Object.assign(PROMO_JOB_OPTIONS, saved);
      };
      const alertsFor = async (campaignId: string) => (await prisma.notification.findMany({ where: { userId: { in: [admin.userId, second.userId] }, type: "campaign.alert" } })).filter((n) => JSON.stringify(n.data).includes(campaignId));

      it("a mail Resend refuses for good marks the recipient FAILED and counts it; more than 5% failed alerts the admins, fewer does not", async () => {
        const a = await audience(25);
        const refused = (n: number) => a.users.slice(0, n).map((u) => u.email);
        t.mail.failWith(422, refused(2));
        const bad = await made({ segment: a.segment });
        await launch(bad.id);
        await finish(bad.id);
        expect(await byStatus(bad.id)).toEqual({ SENT: 23, FAILED: 2 });
        expect((await row(bad.id, a.users[0].id)).skipReason).toBe("resend_422");
        const view = await http().get(`/v1/admin/campaigns/${bad.id}`).set(auth(admin));
        expect(view.body.stats).toMatchObject({ failed: 2 });
        expect(view.body.recipients).toMatchObject({ FAILED: 2, SENT: 23 });
        await until(async () => (await alertsFor(bad.id)).length >= 2); // both super admins are told
        await sender.tick();
        expect((await alertsFor(bad.id)).length).toBe(2); // once per admin, whatever the number of ticks

        const b = await audience(25);
        t.mail.failWith(422, b.users.slice(0, 1).map((u) => u.email)); // 4%
        const fine = await made({ segment: b.segment });
        await launch(fine.id);
        await finish(fine.id);
        expect(await byStatus(fine.id)).toEqual({ SENT: 24, FAILED: 1 });
        expect(await alertsFor(fine.id)).toHaveLength(0);
      });

      it("a 429 or a server error is retried and the mail goes out once it clears; one that never clears ends FAILED", async () => {
        const restore = quickRetries(3);
        try {
          const a = await audience(3);
          const c = await made({ segment: a.segment });
          t.mail.failWith(429);
          await launch(c.id);
          await new Promise((r) => setTimeout(r, 150)); // at least one attempt failed
          expect(sentTo(a.users.map((u) => u.email))).toHaveLength(0);
          t.mail.failWith(null);
          await finish(c.id);
          expect(await byStatus(c.id)).toEqual({ SENT: 3 });

          const b = await audience(3);
          const d = await made({ segment: b.segment });
          t.mail.failWith(503);
          await launch(d.id);
          await until(async () => (await byStatus(d.id)).FAILED === 3);
          expect(sentTo(b.users.map((u) => u.email))).toHaveLength(0);
          expect((await row(d.id, b.users[0].id)).skipReason).toBe("send_failed");
        } finally {
          restore();
        }
      });
    });

    describe("one email per member, whatever crashes (I5)", () => {
      it("claiming a recipient is PENDING -> SENDING with a timestamp; the worker makes it SENT", async () => {
        await hold();
        const a = await audience(2);
        const c = await made({ segment: a.segment });
        await launch(c.id);
        const claimed = await recipients(c.id);
        expect(claimed.map((r) => r.status)).toEqual(["SENDING", "SENDING"]);
        expect(claimed.every((r) => r.sendingAt !== null && r.sentAt === null)).toBe(true);
        await release();
        await finish(c.id);
        expect((await recipients(c.id)).every((r) => r.status === "SENT" && r.sentAt !== null)).toBe(true);
      });

      it("a crash between the claim and the queueing never re-sends: the row stays SENDING, and after 24 hours it is UNKNOWN and counted", async () => {
        const a = await audience(4);
        const emails = a.users.map((u) => u.email);
        const c = await made({ segment: a.segment });
        expect((await act(c.id, "send")).status).toBe(200);
        await sender.start(c.id);
        // two members were claimed by a sender that died before queueing them
        const [lost1, lost2, ok1, ok2] = a.users;
        const claimedAt = (ago: number) => new Date(t.clock.now().getTime() - ago);
        await prisma.campaignRecipient.updateMany({ where: { campaignId: c.id, userId: { in: [lost1.id, lost2.id] } }, data: { status: "SENDING", sendingAt: claimedAt(3600_000) } });
        for (let i = 0; i < 3; i++) await sender.tick();
        await until(async () => sentTo([ok1.email, ok2.email]).length === 2);
        await new Promise((r) => setTimeout(r, 300));
        expect(sentTo([lost1.email, lost2.email])).toHaveLength(0); // not re-claimed, not re-sent
        expect(await byStatus(c.id)).toEqual({ SENDING: 2, SENT: 2 });
        expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("SENDING"); // not finished while a mail may still be in flight

        await prisma.campaignRecipient.updateMany({ where: { campaignId: c.id, userId: { in: [lost1.id, lost2.id] } }, data: { sendingAt: claimedAt(25 * 3600_000) } });
        await finish(c.id);
        expect(await byStatus(c.id)).toEqual({ UNKNOWN: 2, SENT: 2 });
        expect(sentTo(emails)).toHaveLength(2);
        const view = await http().get(`/v1/admin/campaigns/${c.id}`).set(auth(admin));
        expect(view.body.stats).toMatchObject({ unknown: 2 });
        expect(view.body.recipients).toMatchObject({ UNKNOWN: 2, SENT: 2 });
      });

      it("a job delivered twice (the worker died after Resend answered) sends one mail: a finished recipient is left alone, and Resend's idempotency key covers an unfinished one", async () => {
        const processor = t.app.get(PromoMailProcessor);
        const a = await audience(2);
        const [done, unfinished] = a.users;
        const c = await made({ segment: a.segment });
        await hold();
        await launch(c.id);
        // worker died before the row was marked: the row is still SENDING and the job comes back
        await processor.process(fakeJob(c.id, unfinished.id));
        expect(sentTo([unfinished.email])).toHaveLength(1);
        await prisma.campaignRecipient.update({ where: { campaignId_userId: { campaignId: c.id, userId: unfinished.id } }, data: { status: "SENDING", sentAt: null, resendId: null } });
        await processor.process(fakeJob(c.id, unfinished.id));
        expect(sentTo([unfinished.email])).toHaveLength(1);
        // worker died after the row was marked: the job comes back and finds nothing to do
        await processor.process(fakeJob(c.id, done.id));
        await processor.process(fakeJob(c.id, done.id));
        expect(sentTo([done.email])).toHaveLength(1);
        await release();
        await finish(c.id);
        expect(sentTo(a.users.map((u) => u.email))).toHaveLength(2);
      });

      it("concurrent claims never hand the same recipient to two senders", async () => {
        await hold();
        const a = await audience(60);
        const c = await made({ segment: a.segment });
        expect((await act(c.id, "send")).status).toBe(200);
        await sender.start(c.id);
        const batches = await Promise.all(Array.from({ length: 8 }, () => sender.claimBatch(c.id, 10)));
        const all = batches.flat();
        expect(new Set(all).size).toBe(all.length); // nobody twice
        expect(all).toHaveLength(60);
        expect(await byStatus(c.id)).toEqual({ SENDING: 60 });
        await prisma.campaignRecipient.updateMany({ where: { campaignId: c.id }, data: { status: "SKIPPED", skipReason: "cancelled" } });
        await act(c.id, "cancel");
      });

      it("two ticks running at once send each member exactly one mail", async () => {
        const a = await audience(40);
        const emails = a.users.map((u) => u.email);
        const c = await made({ segment: a.segment });
        expect((await act(c.id, "send")).status).toBe(200);
        await Promise.all([sender.tick(), sender.tick(), sender.tick()]);
        await finish(c.id);
        await new Promise((r) => setTimeout(r, 300));
        for (const e of emails) expect(sentTo([e])).toHaveLength(1);
      });
    });
  });

  describe("approval above 10,000 recipients", () => {
    let bigAudience: ReturnType<typeof audience> | undefined;
    const big = () => (bigAudience ??= audience(10_001, bulkEmailPrefix));

    it("needs a second admin; the creator cannot approve their own; an edit withdraws the approval", async () => {
      const a = await big();
      const c = await made({ segment: a.segment });
      const preview = await act(c.id, "preview");
      expect(preview.body).toEqual({ audience: 10_001, requiresApproval: true });
      const blocked = await act(c.id, "send");
      expect([blocked.status, blocked.body.error.code]).toEqual([409, "CAMPAIGN_APPROVAL_REQUIRED"]);
      const own = await act(c.id, "approve");
      expect([own.status, own.body.error.code]).toEqual([403, "CAMPAIGN_SELF_APPROVAL"]);
      const member = await t.login();
      expect((await act(c.id, "approve", {}, member)).status).toBe(403);
      const ok = await act(c.id, "approve", {}, second);
      expect([ok.status, ok.body.approvedById]).toEqual([200, second.userId]);
      expect(await prisma.auditLog.count({ where: { action: "campaign.approve", targetId: c.id } })).toBe(1);
      // changing the audience or the text withdraws the approval
      const edit = await http().patch(`/v1/admin/campaigns/${c.id}`).set(auth(admin)).send({ subject: "Edited after approval" });
      expect(edit.body.approvedById).toBeNull();
      expect((await act(c.id, "send")).status).toBe(409);
      expect((await act(c.id, "approve", {}, second)).status).toBe(200);
      const sent = await act(c.id, "send");
      expect([sent.status, sent.body.status]).toEqual([200, "SCHEDULED"]);
      // not starting 10,001 mails in a test
      expect((await act(c.id, "cancel")).body.status).toBe("CANCELLED");
      // a small campaign needs no approval at all
      const small = await audience(2);
      const sc = await made({ segment: small.segment });
      expect((await act(sc.id, "send")).status).toBe(200);
      await act(sc.id, "cancel");
    });

    it("the second-admin rule cannot be bypassed: whoever last edited a draft cannot approve it, and an approval counts only for the content approved (I1)", async () => {
      const a = await big();
      const third = await superAdmin();
      const draft = await made({ segment: { interests: ["tag:nobody-has-this"] }, subject: "Small draft" }); // by admin: harmless on its own
      // admin B (second) takes the draft, widens it to the whole audience, and tries to be its approver
      const edit = await http().patch(`/v1/admin/campaigns/${draft.id}`).set(auth(second)).send({ segment: a.segment, subject: "Now for everyone" });
      expect(edit.status).toBe(200);
      const viaEditor = await act(draft.id, "approve", {}, second);
      expect([viaEditor.status, viaEditor.body.error.code]).toEqual([403, "CAMPAIGN_SELF_APPROVAL"]);
      const viaCreator = await act(draft.id, "approve", {}, admin);
      expect([viaCreator.status, viaCreator.body.error.code]).toEqual([403, "CAMPAIGN_SELF_APPROVAL"]);
      const blocked = await act(draft.id, "send", {}, second);
      expect([blocked.status, blocked.body.error.code]).toEqual([409, "CAMPAIGN_APPROVAL_REQUIRED"]);
      // a third admin who did not touch it can approve; the editor then cannot be quietly swapped back in
      expect((await act(draft.id, "approve", {}, third)).status).toBe(200);
      const edited = await http().patch(`/v1/admin/campaigns/${draft.id}`).set(auth(third)).send({ subject: "Third admin edits" });
      expect(edited.body.approvedById).toBeNull();
      expect((await act(draft.id, "approve", {}, third)).status).toBe(403); // now third is the last editor
      expect((await act(draft.id, "approve", {}, second)).status).toBe(200); // second has not edited since
      expect((await act(draft.id, "send")).status).toBe(200);
      await act(draft.id, "cancel");

      // content changed behind the API's back (an edit path that forgot to withdraw the approval): the hash no longer matches
      const c = await made({ segment: a.segment });
      expect((await act(c.id, "approve", {}, second)).status).toBe(200);
      await prisma.campaign.update({ where: { id: c.id }, data: { bodyMarkdown: "Changed after the approval" } });
      const tampered = await act(c.id, "send");
      expect([tampered.status, tampered.body.error.code]).toEqual([409, "CAMPAIGN_APPROVAL_REQUIRED"]);

      // ... and the same check holds when a scheduled campaign starts
      const d = await made({ segment: a.segment });
      expect((await act(d.id, "approve", {}, second)).status).toBe(200);
      expect((await act(d.id, "send")).status).toBe(200);
      await prisma.campaign.update({ where: { id: d.id }, data: { subject: "Swapped while scheduled" } });
      await sender.start(d.id);
      const after = await prisma.campaign.findUniqueOrThrow({ where: { id: d.id } });
      expect(after.status).toBe("DRAFT");
      expect(await prisma.campaignRecipient.count({ where: { campaignId: d.id } })).toBe(0);
    }, 120_000);
  });

  describe("approval is re-checked when a scheduled campaign starts", () => {
    it("an audience that grew past 10,000 since `send` is refused without a second admin's approval: back to DRAFT, creator told, nothing queued", async () => {
      const stamp = uniq();
      const tag = `t${uniq()}`;
      await prisma.user.createMany({ data: Array.from({ length: 10_001 }, (_, i) => ({ email: `${bulkEmailPrefix}-g${stamp}-${i}@example.com`, status: "ACTIVE" as const })) });
      const users = await prisma.user.findMany({ where: { email: { startsWith: `${bulkEmailPrefix}-g${stamp}-` } }, select: { id: true } });
      const c = await made({ segment: { interests: [`tag:${tag}`] } });
      expect((await act(c.id, "preview")).body).toEqual({ audience: 0, requiresApproval: false });
      expect((await act(c.id, "send")).status).toBe(200); // small at the time: no approval needed
      // the audience grows before the scheduler gets to it
      await prisma.userInterest.createMany({ data: users.map((u) => ({ userId: u.id, key: `tag:${tag}`, weight: 5, updatedAt: new Date() })) });

      await sender.tick();
      const after = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
      expect(after.status).toBe("DRAFT");
      expect(after.startedAt).toBeNull();
      expect(await prisma.campaignRecipient.count({ where: { campaignId: c.id } })).toBe(0);
      const told = await prisma.notification.findMany({ where: { userId: admin.userId, type: "campaign.approval_needed" } });
      expect(told.some((n) => JSON.stringify(n.data).includes(c.id))).toBe(true);
      // a second tick does not start it either (it is no longer scheduled), and it can be approved and sent again
      await sender.tick();
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("DRAFT");
      expect((await act(c.id, "send")).body.error.code).toBe("CAMPAIGN_APPROVAL_REQUIRED");
      expect((await act(c.id, "approve", {}, second)).status).toBe(200);
      expect((await act(c.id, "send")).status).toBe(200);
      await sender.start(c.id); // with the approval, the same audience starts
      const started = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
      expect([started.status, started.audienceSize]).toEqual(["SENDING", 10_001]);
      await act(c.id, "cancel");
    }, 180_000);
  });

  describe("unsubscribe (Review Focus 2)", () => {
    async function mailFor(user: { id: string; email: string }) {
      const tag = `u${uniq()}`;
      await prisma.userInterest.create({ data: { userId: user.id, key: `tag:${tag}`, weight: 5, updatedAt: new Date() } });
      const c = await made({ segment: { interests: [`tag:${tag}`] } });
      await launch(c.id);
      const mail = await until(async () => t.mail.sent.find((m) => m.to === user.email && m.headers?.["List-Unsubscribe"]));
      return { mail, token: tokenFrom(mail.headers!["List-Unsubscribe"]), campaignId: c.id };
    }
    /** The visible Unsubscribe link of the mail, as a path and query the test server can be asked for. */
    const linkIn = (html: string) => {
      const href = /href="([^"]*\/v1\/unsubscribe[^"]*)"/.exec(html)?.[1];
      expect(href).toBeTruthy();
      const url = new URL(href!.replace(/&amp;/g, "&"));
      return url.pathname + url.search;
    };
    const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1]?.replace(/&amp;/g, "&");
    const ipHeader = () => ["X-Forwarded-For", uniqueIp()] as const;

    it("the Unsubscribe link in the mail opens a confirmation page that changes nothing; its button unsubscribes, suppresses, and every later campaign honours it (C2)", async () => {
      const [u] = (await audience(1)).users;
      const { mail } = await mailFor(u);
      const link = linkIn(mail.html);
      for (let i = 0; i < 3; i++) {
        const page = await http().get(link).set(...ipHeader());
        expect(page.status).toBe(200);
        expect(page.headers["content-type"]).toMatch(/^text\/html/);
        expect(page.headers["cache-control"]).toMatch(/no-store/);
        expect(page.text).toMatch(/<button[^>]*type="submit"[^>]*>\s*Unsubscribe\s*<\/button>/i);
        expect(page.text).not.toContain(u.email);
        expect(page.text).not.toContain("example.com");
        const form = /<form\b[^>]*>/i.exec(page.text)![0];
        expect(attr(form, "method")?.toLowerCase()).toBe("post");
        expect(attr(form, "action")).toBeUndefined(); // no action: the button posts back to the same signed link
      }
      // a scanner (or a click that never reached the button) has changed nothing
      expect(await prisma.emailSuppression.findUnique({ where: { email: u.email } })).toBeNull();
      expect(await prisma.notificationPreference.findUnique({ where: { userId_type: { userId: u.id, type: "promo" } } })).toBeNull();

      // the button: a POST of the form
      const done = await http().post(link).type("form").send({}).set(...ipHeader());
      expect(done.status).toBe(200);
      expect(done.headers["content-type"]).toMatch(/^text\/html/);
      expect(done.text).toMatch(/unsubscribed/i);
      expect(done.text).not.toContain(u.email);
      expect(await prisma.emailSuppression.findUniqueOrThrow({ where: { email: u.email } })).toMatchObject({ reason: "unsubscribed" });
      expect(await prisma.notificationPreference.findUniqueOrThrow({ where: { userId_type: { userId: u.id, type: "promo" } } })).toMatchObject({ email: false });
      expect((await http().post(link).type("form").send({}).set(...ipHeader())).status).toBe(200); // repeating is harmless

      // the next campaign skips this member, with or without the preference row
      await prisma.notificationPreference.delete({ where: { userId_type: { userId: u.id, type: "promo" } } });
      const before = t.mail.sent.filter((m) => m.to === u.email).length;
      const tag = `v${uniq()}`;
      await prisma.userInterest.create({ data: { userId: u.id, key: `tag:${tag}`, weight: 5, updatedAt: new Date() } });
      const c = await made({ segment: { interests: [`tag:${tag}`] } });
      await launch(c.id);
      await until(async () => (await recipients(c.id))[0]?.status === "SKIPPED");
      expect((await recipients(c.id))[0]).toMatchObject({ status: "SKIPPED", skipReason: "suppressed" });
      await new Promise((r) => setTimeout(r, 300));
      expect(t.mail.sent.filter((m) => m.to === u.email)).toHaveLength(before);

      // turning the preference back on lifts the unsubscribe suppression, and only that one
      const me = await t.login(u.email);
      const on = await http().put("/v1/me/notification-preferences").set(auth(me)).send({ items: [{ type: "promo", email: true }] });
      expect(on.status).toBe(200);
      expect(on.body.items.find((i: { type: string }) => i.type === "promo")).toMatchObject({ email: true });
      expect(await prisma.emailSuppression.findUnique({ where: { email: u.email } })).toBeNull();
    });

    it("the one-click POST of a mailbox provider (RFC 8058) unsubscribes at once and answers 200 without the address", async () => {
      const [u] = (await audience(1)).users;
      const { token } = await mailFor(u);
      const post = await http().post(`/v1/unsubscribe?t=${encodeURIComponent(token)}`).set("Content-Type", "application/x-www-form-urlencoded").set(...ipHeader()).send("List-Unsubscribe=One-Click");
      expect(post.status).toBe(200);
      expect(post.body).toEqual({ unsubscribed: true, category: "promotional" });
      expect(JSON.stringify(post.body)).not.toContain(u.email);
      expect(await prisma.emailSuppression.findUniqueOrThrow({ where: { email: u.email } })).toMatchObject({ reason: "unsubscribed" });
    });

    it("forged, tampered, truncated and cross-purpose tokens are a 400 that reveals no address and changes nothing", async () => {
      const [u, other] = (await audience(2)).users;
      const { token } = await mailFor(u);
      const [body, sig] = token.split(".");
      const swapped = Buffer.from(JSON.stringify({ u: other.id, c: "promotional" })).toString("base64url");
      const bad = [`${body}.${sig.slice(0, -3)}AAA`, `${swapped}.${sig}`, body, "", "garbage.garbage", `${token}x`, `${sig}.${body}`];
      for (const t2 of bad) {
        for (const method of ["get", "post"] as const) {
          const res = await http()[method](`/v1/unsubscribe?t=${encodeURIComponent(t2)}`).set(...ipHeader());
          expect([method, t2.slice(0, 12), res.status]).toEqual([method, t2.slice(0, 12), 400]);
          expect(res.text).toMatch(/not valid/i);
          for (const email of [u.email, other.email]) expect(res.text).not.toContain(email);
        }
        const oneClick = await http().post(`/v1/unsubscribe?t=${encodeURIComponent(t2)}`).type("form").send("List-Unsubscribe=One-Click").set(...ipHeader());
        expect([t2.slice(0, 12), oneClick.status, oneClick.body.error?.code]).toEqual([t2.slice(0, 12), 400, "UNSUBSCRIBE_TOKEN_INVALID"]);
      }
      expect((await http().get("/v1/unsubscribe").set(...ipHeader())).status).toBe(400);
      expect(await prisma.emailSuppression.findMany({ where: { email: { in: [u.email, other.email] } } })).toEqual([]);
    });

    it("an unsubscribe never downgrades a bounce", async () => {
      const [u] = (await audience(1)).users;
      const { token } = await mailFor(u);
      await prisma.emailSuppression.upsert({ where: { email: u.email }, create: { email: u.email, reason: "bounced" }, update: { reason: "bounced" } });
      expect((await http().post(`/v1/unsubscribe?t=${encodeURIComponent(token)}`).set(...ipHeader())).status).toBe(200);
      expect((await prisma.emailSuppression.findUniqueOrThrow({ where: { email: u.email } })).reason).toBe("bounced");
    });

    it("a validly signed POST is not limited by IP (mailbox providers send thousands from a few addresses); a token is limited per token, and bad tokens per IP (I6)", async () => {
      const a = await audience(200, bulkEmailPrefix);
      const tokens = a.users.map((u) => t.app.get(UnsubscribeTokens).sign(u.id));
      const sameIp = uniqueIp();
      const statuses: number[] = [];
      for (let i = 0; i < tokens.length; i += 25) {
        const chunk = await Promise.all(tokens.slice(i, i + 25).map((tok) => http().post(`/v1/unsubscribe?t=${encodeURIComponent(tok)}`).set("X-Forwarded-For", sameIp).type("form").send("List-Unsubscribe=One-Click")));
        statuses.push(...chunk.map((r) => r.status));
      }
      expect(statuses.filter((s) => s !== 200)).toEqual([]);
      expect(await prisma.emailSuppression.count({ where: { email: { in: a.users.map((u) => u.email) } } })).toBe(200);

      // one token cannot be hammered (its first use was in the burst above)
      const repeats: number[] = [];
      for (let i = 0; i < 12; i++) repeats.push((await http().post(`/v1/unsubscribe?t=${encodeURIComponent(tokens[0])}`).set(...ipHeader())).status);
      expect(repeats.slice(0, 9)).toEqual(Array(9).fill(200));
      expect(repeats.slice(9)).toEqual([429, 429, 429]);

      // guessing tokens is limited per IP
      const guessIp = uniqueIp();
      const guesses: number[] = [];
      for (let i = 0; i < 24; i++) guesses.push((await http().post(`/v1/unsubscribe?t=guess-${i}`).set("X-Forwarded-For", guessIp)).status);
      expect(guesses.slice(0, 20)).toEqual(Array(20).fill(400));
      expect(guesses.slice(20)).toEqual([429, 429, 429, 429]);
    }, 120_000);
  });

  describe("stats from Resend webhooks", () => {
    const sign = (body: object) => {
      const payload = JSON.stringify(body);
      const id = `msg_${randomUUID()}`;
      const timestamp = new Date();
      return { payload, headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)), "svix-signature": new Webhook(WEBHOOK_SECRET).sign(id, timestamp, payload) } };
    };
    const deliver = async (type: string, resendId: string, to: string) => {
      const s = sign({ type, created_at: new Date().toISOString(), data: { email_id: resendId, to: [to] } });
      return http().post("/v1/webhooks/resend").set(s.headers).send(s.payload);
    };

    it("delivered, opened, clicked, bounced and complained are counted once per recipient, whatever the repeats", async () => {
      const a = await audience(3);
      const c = await made({ segment: a.segment });
      await launch(c.id);
      const rows = await until(async () => {
        const r = await recipients(c.id);
        return r.length === 3 && r.every((x) => x.resendId) ? r : null;
      });
      const [r1, r2, r3] = rows;
      const mailOf = (r: (typeof rows)[number]) => a.users.find((u) => u.id === r.userId)!.email;
      for (const r of rows) expect((await deliver("email.delivered", r.resendId!, mailOf(r))).status).toBe(200);
      for (let i = 0; i < 3; i++) await deliver("email.opened", r1.resendId!, mailOf(r1)); // the same open three times
      await deliver("email.opened", r2.resendId!, mailOf(r2));
      await deliver("email.clicked", r1.resendId!, mailOf(r1));
      await deliver("email.bounced", r3.resendId!, mailOf(r3));
      const replay = sign({ type: "email.complained", data: { email_id: r2.resendId, to: [mailOf(r2)] } });
      for (let i = 0; i < 2; i++) await http().post("/v1/webhooks/resend").set(replay.headers).send(replay.payload).expect(200);
      const view = await http().get(`/v1/admin/campaigns/${c.id}`).set(auth(admin));
      expect(view.body.stats).toMatchObject({ delivered: 3, opened: 2, clicked: 1, bounced: 1, complained: 1 });
      expect(view.body.recipients).toMatchObject({ SENT: 3 });
      expect((await deliver("email.delivered", "no-such-id", "x@example.com")).status).toBe(200); // unknown ids are ignored
      expect((await deliver("email.opened", "fake-0", "x@example.com")).status).toBe(200);
      // bounce and complaint still suppress (existing behaviour)
      expect((await prisma.emailSuppression.findUniqueOrThrow({ where: { email: mailOf(r3) } })).reason).toBe("bounced");
    });
  });
});
