import { randomUUID } from "node:crypto";
import request from "supertest";
import { Webhook } from "svix";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { SettingsService } from "../../src/modules/admin";
import { CampaignSender } from "../../src/modules/growth";
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
    it("sends once per member with the unsubscribe footer and one-click headers; the footer cannot be written out of the body", async () => {
      const a = await audience(3);
      const c = await made({ segment: a.segment, subject: "Spring sale", bodyMarkdown: "No footer please. Do not mention any unsubscribe link." });
      const send = await act(c.id, "send");
      expect([send.status, send.body.status]).toEqual([200, "SCHEDULED"]);
      expect(await prisma.auditLog.count({ where: { action: "campaign.send", targetId: c.id } })).toBe(1);
      await sender.tick();
      const emails = a.users.map((u) => u.email);
      await until(async () => sentTo(emails).length === 3);
      const view = await http().get(`/v1/admin/campaigns/${c.id}`).set(auth(admin));
      expect(view.body.status).toBe("SENT");
      for (const m of sentTo(emails)) {
        expect(m.subject).toBe("Spring sale");
        expect(m.html).toMatch(/unsubscribe/i);
        expect(m.text).toMatch(/unsubscribe/i);
        expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
        expect(m.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/app\.skiller\.test\/v1\/unsubscribe\?t=[^>]+>$/);
        expect(m.html).toContain(new URL(/<([^>]+)>/.exec(m.headers!["List-Unsubscribe"])![1]).href.replace(/&/g, "&amp;"));
        expect(m.idempotencyKey).toContain(c.id);
      }
      const rows = await recipients(c.id);
      expect(rows.map((r) => r.status)).toEqual(["SENT", "SENT", "SENT"]);
      await until(async () => (await recipients(c.id)).every((r) => r.resendId));
      // running the sender again sends nothing more
      await sender.tick();
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
        await until(async () => (await recipients(c2.id)).every((r) => r.status !== "PENDING"));
        const rows = new Map((await recipients(c2.id)).map((r) => [r.userId, r]));
        expect(rows.get(b.users[0].id)?.status).toBe("SENT");
        expect(rows.get(b.users[1].id)).toMatchObject({ status: "SKIPPED", skipReason: "marketing_opt_in_required" });
        expect(rows.get(b.users[2].id)).toMatchObject({ status: "SKIPPED", skipReason: "marketing_opt_in_required" });
        expect(sentTo([b.users[1].email, b.users[2].email])).toHaveLength(0);
      } finally {
        await settings.set(admin.userId, "marketing_opt_in_required", false, {});
      }
    });

    it("works in batches of 100, pauses and resumes between batches, and cancel stops the rest", async () => {
      const a = await audience(250, bulkEmailPrefix);
      const emails = a.users.map((u) => u.email);
      const c = await made({ segment: a.segment });
      expect((await act(c.id, "send")).status).toBe(200);
      // approval is needed above 10,000 only; 250 goes straight through. The tick starts it (writes the recipients); one batch = 100 recipients.
      await sender.start(c.id);
      await sender.run(c.id, { maxBatches: 1 });
      expect((await recipients(c.id)).filter((r) => r.status !== "PENDING")).toHaveLength(100);
      expect((await act(c.id, "pause")).body.status).toBe("PAUSED");
      await sender.run(c.id, { maxBatches: 5 });
      expect((await recipients(c.id)).filter((r) => r.status !== "PENDING")).toHaveLength(100); // paused: nothing moves
      expect((await act(c.id, "resume")).body.status).toBe("SENDING");
      await sender.run(c.id, { maxBatches: 1 });
      expect((await recipients(c.id)).filter((r) => r.status !== "PENDING")).toHaveLength(200);
      const cancel = await act(c.id, "cancel");
      expect([cancel.status, cancel.body.status]).toEqual([200, "CANCELLED"]);
      await sender.run(c.id, { maxBatches: 5 });
      const rows = await recipients(c.id);
      expect(rows.filter((r) => r.status === "SENT")).toHaveLength(200);
      expect(rows.filter((r) => r.status === "SKIPPED" && r.skipReason === "cancelled")).toHaveLength(50);
      await until(async () => sentTo(emails).length === 200);
      expect((await act(c.id, "resume")).status).toBe(409);
      for (const action of ["campaign.pause", "campaign.resume", "campaign.cancel"]) expect(await prisma.auditLog.count({ where: { action, targetId: c.id } })).toBe(1);
    });

    it("a resumed campaign never double-sends (Review Focus 2): stale claims are reclaimed, finished recipients stay finished, and a re-enqueue is a no-op", async () => {
      const a = await audience(5);
      const emails = a.users.map((u) => u.email);
      const c = await made({ segment: a.segment });
      await launch(c.id);
      await until(async () => sentTo(emails).length === 5);

      // crash A: after the claim, before the send: the rows are claimed long ago and still PENDING
      const stale = new Date(t.clock.now().getTime() - 3600_000);
      const rows = await recipients(c.id);
      await prisma.campaignRecipient.updateMany({ where: { campaignId: c.id, userId: { in: [rows[0].userId, rows[1].userId] } }, data: { status: "PENDING", sentAt: null, claimedAt: stale, resendId: null } });
      // crash B: mail enqueued but the status write was lost: PENDING, claimed long ago, mail already out
      await prisma.campaignRecipient.updateMany({ where: { campaignId: c.id, userId: rows[2].userId }, data: { status: "PENDING", sentAt: null, claimedAt: stale } });
      await prisma.campaign.update({ where: { id: c.id }, data: { status: "SENDING", finishedAt: null } });
      await sender.tick();
      await new Promise((r) => setTimeout(r, 600));
      expect(sentTo(emails)).toHaveLength(5); // not one more than before
      expect((await recipients(c.id)).every((r) => r.status === "SENT")).toBe(true);

      // a fresh claim (another worker is mid-batch) is left alone
      await prisma.campaignRecipient.updateMany({ where: { campaignId: c.id, userId: rows[3].userId }, data: { status: "PENDING", sentAt: null, claimedAt: t.clock.now() } });
      await prisma.campaign.update({ where: { id: c.id }, data: { status: "SENDING", finishedAt: null } });
      await sender.tick();
      expect((await prisma.campaignRecipient.findUniqueOrThrow({ where: { campaignId_userId: { campaignId: c.id, userId: rows[3].userId } } })).status).toBe("PENDING");
    });

    it("two senders running at once split the work: nobody is claimed twice", async () => {
      const a = await audience(40);
      const emails = a.users.map((u) => u.email);
      const c = await made({ segment: a.segment });
      expect((await act(c.id, "send")).status).toBe(200);
      await Promise.all([sender.tick(), sender.tick(), sender.tick()]);
      await until(async () => sentTo(emails).length >= 40);
      await new Promise((r) => setTimeout(r, 400));
      for (const e of emails) expect(sentTo([e])).toHaveLength(1);
    });
  });

  describe("approval above 10,000 recipients", () => {
    it("needs a second admin; the creator cannot approve their own; an edit withdraws the approval", async () => {
      const a = await audience(10_001, bulkEmailPrefix);
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

    it("a signed link shows a confirmation without revealing the address; one click unsubscribes, suppresses and is honoured by every later campaign", async () => {
      const [u] = (await audience(1)).users;
      const { token } = await mailFor(u);
      const show = await http().get(`/v1/unsubscribe?t=${encodeURIComponent(token)}`).set("X-Forwarded-For", uniqueIp());
      expect(show.status).toBe(200);
      expect(show.body).toEqual({ category: "promotional", alreadyUnsubscribed: false });
      expect(JSON.stringify(show.body)).not.toContain(u.email);
      expect(JSON.stringify(show.body)).not.toContain("example.com");
      expect(await prisma.emailSuppression.findUnique({ where: { email: u.email } })).toBeNull(); // GET changes nothing

      const post = await http().post(`/v1/unsubscribe?t=${encodeURIComponent(token)}`).set("Content-Type", "application/x-www-form-urlencoded").set("X-Forwarded-For", uniqueIp()).send("List-Unsubscribe=One-Click");
      expect(post.status).toBe(200);
      expect(JSON.stringify(post.body)).not.toContain(u.email);
      expect(await prisma.emailSuppression.findUniqueOrThrow({ where: { email: u.email } })).toMatchObject({ reason: "unsubscribed" });
      expect(await prisma.notificationPreference.findUniqueOrThrow({ where: { userId_type: { userId: u.id, type: "promo" } } })).toMatchObject({ email: false });
      expect((await http().post(`/v1/unsubscribe?t=${encodeURIComponent(token)}`).set("X-Forwarded-For", uniqueIp())).status).toBe(200); // repeating is harmless
      expect((await http().get(`/v1/unsubscribe?t=${encodeURIComponent(token)}`).set("X-Forwarded-For", uniqueIp())).body.alreadyUnsubscribed).toBe(true);

      // the next campaign skips this member, with or without the preference row
      await prisma.notificationPreference.delete({ where: { userId_type: { userId: u.id, type: "promo" } } });
      const before = t.mail.sent.filter((m) => m.to === u.email).length;
      const tag = `v${uniq()}`;
      await prisma.userInterest.create({ data: { userId: u.id, key: `tag:${tag}`, weight: 5, updatedAt: new Date() } });
      const c = await made({ segment: { interests: [`tag:${tag}`] } });
      await launch(c.id);
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

    it("forged, tampered, truncated and cross-purpose tokens are a 400 and change nothing", async () => {
      const [u, other] = (await audience(2)).users;
      const { token } = await mailFor(u);
      const [body, sig] = token.split(".");
      const swapped = Buffer.from(JSON.stringify({ u: other.id, c: "promotional" })).toString("base64url");
      const bad = [`${body}.${sig.slice(0, -3)}AAA`, `${swapped}.${sig}`, body, "", "garbage.garbage", `${token}x`, `${sig}.${body}`];
      for (const t2 of bad) {
        for (const method of ["get", "post"] as const) {
          const res = await http()[method](`/v1/unsubscribe?t=${encodeURIComponent(t2)}`).set("X-Forwarded-For", uniqueIp());
          expect([method, t2.slice(0, 12), res.status, res.body.error?.code]).toEqual([method, t2.slice(0, 12), 400, "UNSUBSCRIBE_TOKEN_INVALID"]);
        }
      }
      expect((await http().get("/v1/unsubscribe").set("X-Forwarded-For", uniqueIp())).status).toBe(400);
      expect(await prisma.emailSuppression.findMany({ where: { email: { in: [u.email, other.email] } } })).toEqual([]);
    });

    it("an unsubscribe never downgrades a bounce", async () => {
      const [u] = (await audience(1)).users;
      const { token } = await mailFor(u);
      await prisma.emailSuppression.upsert({ where: { email: u.email }, create: { email: u.email, reason: "bounced" }, update: { reason: "bounced" } });
      expect((await http().post(`/v1/unsubscribe?t=${encodeURIComponent(token)}`).set("X-Forwarded-For", uniqueIp())).status).toBe(200);
      expect((await prisma.emailSuppression.findUniqueOrThrow({ where: { email: u.email } })).reason).toBe("bounced");
    });
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
