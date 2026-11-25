import { randomInt, randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import request from "supertest";
import { ActivityTracker } from "../../src/common/activity/activity-tracker";
import { addDays, istDateOf, istDayRange } from "../../src/common/clock/ist";
import type { MetricsProvider } from "../../src/common/metrics/metrics-provider";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { QueueNames, queueToken } from "../../src/common/queue/queue.constants";
import { REDIS } from "../../src/common/redis/redis.constants";
import { FakeRazorpayClient, FakeRazorpayXClient, RAZORPAY_CLIENT, RAZORPAYX_CLIENT, RefundsService } from "../../src/modules/billing";
import { METRIC_KEYS } from "../../src/modules/analytics/metric-catalog";
import { AnalyticsService } from "../../src/modules/analytics/analytics.service";
import { METRICS_PROVIDERS, RollupService } from "../../src/modules/analytics/rollup.service";
import { ANALYTICS_REBUILD_JOB, RollupProcessor } from "../../src/modules/analytics/rollup.processor";
import { RolesService } from "../../src/modules/rbac";
import { createAuthTestApp, uniqueIp, type AuthTestApp } from "../support/auth-app";
import { paidOrder } from "../support/orders";
import { until } from "../support/payouts";
import { TestItemProvider } from "../support/test-item";
import { givePlan } from "../support/billing";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);
const MS_DAY = 86_400_000;

describe("growth dashboards: rollup, endpoints, activity", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let rollup: RollupService;
  let admin: Session;
  const fake = new FakeRazorpayClient({ keySecret: "razorpay-key-secret-for-tests", webhookSecret: "razorpay-webhook-secret-for-tests", webhookXSecret: "razorpayx-webhook-secret-for-tests" });
  const fakeX = new FakeRazorpayXClient({ webhookSecret: "razorpayx-webhook-secret-for-tests" });
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  async function stepUp(s: Session) {
    const before = t.mail.sent.filter((m) => m.to === s.email).length;
    const res = await http().post("/v1/auth/step-up/request").set(auth(s)).set("X-Forwarded-For", uniqueIp());
    expect(res.status).toBe(202);
    const code = await t.codeFor(s.email, before);
    await http().post("/v1/auth/step-up/verify").set(auth(s)).send({ challengeId: res.body.challengeId, code }).expect(204);
  }

  /** A far-away IST day nothing else in the shared database touches (a random date in 2001-2019), and the UTC instant it starts at. */
  const day = `${randomInt(2001, 2020)}-${String(randomInt(1, 13)).padStart(2, "0")}-${String(randomInt(10, 29))}`;
  const start = istDayRange(day).from.getTime();
  const at = (offsetMs: number) => new Date(start + offsetMs);
  const created: { users: string[]; orders: string[]; gigs: string[]; conversations: string[]; campaigns: string[]; reports: string[]; payouts: string[]; courses: string[]; reels: string[] } = {
    users: [],
    orders: [],
    gigs: [],
    conversations: [],
    campaigns: [],
    reports: [],
    payouts: [],
    courses: [],
    reels: [],
  };

  async function user(createdAt: Date) {
    const u = await prisma.user.create({ data: { email: `an-${uniq()}@example.com`, createdAt } });
    created.users.push(u.id);
    return u;
  }

  /** Everything the rollup reads, seeded straight into the source tables with explicit timestamps around the IST boundaries of `day`. */
  async function seedDay() {
    // Users: 1 ms before the IST day, its first and last millisecond, and the first millisecond of the next day.
    const before = await user(at(-1));
    const first = await user(at(0));
    const midday = await user(at(12 * 3600_000));
    const last = await user(at(MS_DAY - 1));
    const after = await user(at(MS_DAY));
    const creator = await prisma.role.findFirstOrThrow({ where: { key: "creator" } });
    for (const [u, when] of [[first, at(5)], [midday, at(6 * 3600_000)], [before, at(-1)], [after, at(MS_DAY)]] as const) {
      await prisma.userRole.create({ data: { userId: u.id, roleId: creator.id, createdAt: when } });
    }

    // Orders: 3 paid, 1 refunded (still a sale on its day), 1 created (never paid), 1 paid 1 ms before the day.
    const planVersion = await prisma.planVersion.findFirstOrThrow();
    const sellerA = randomUUID();
    const sellerB = randomUUID();
    const sellerC = randomUUID();
    const order = async (sellerOwnerId: string, totalPaise: bigint, status: "PAID" | "REFUNDED" | "CREATED", paidAt: Date | null) => {
      const o = await prisma.order.create({
        data: { buyerId: randomUUID(), status, listPricePaise: totalPaise, totalPaise, sellerOwnerType: "USER", sellerOwnerId, commissionBps: 1000, gstBps: 1800, planVersionId: planVersion.id, paidAt, createdAt: paidAt ?? at(1000) },
      });
      created.orders.push(o.id);
    };
    await order(sellerA, 49900n, "PAID", at(1000));
    await order(sellerA, 150000n, "PAID", at(2000));
    await order(sellerB, 25000n, "PAID", at(MS_DAY - 1)); // sellerB sold before: not a first sale
    await order(sellerB, 5000n, "PAID", at(-5 * MS_DAY));
    await order(sellerC, 30000n, "REFUNDED", at(3000));
    await order(sellerA, 99900n, "CREATED", null);
    await order(sellerC, 77700n, "PAID", at(-1)); // sellerC's earlier sale is the day before (and not in `day`): then C's REFUNDED order is not a first sale either
    // -> first sales on `day`: sellerA only. (sellerC sold 1 ms earlier, sellerB 5 days earlier.)

    const payout = async (status: "PAID" | "REQUESTED", paidAt: Date | null, amountPaise: bigint) => {
      const p = await prisma.payout.create({
        data: { ownerType: "USER", ownerId: randomUUID(), payoutAccountId: randomUUID(), amountPaise, tdsBps: 100, tdsPaise: 0n, mode: "IMPS", status, requestedBy: randomUUID(), paidAt },
      });
      created.payouts.push(p.id);
    };
    await payout("PAID", at(4000), 70000n);
    await payout("PAID", at(MS_DAY), 11111n); // next day
    await payout("REQUESTED", null, 9999n);

    // Reports: opened on the day (3), upheld on the day (2: one opened earlier).
    const report = async (status: "OPEN" | "UPHELD" | "DISMISSED", createdAt: Date, decidedAt: Date | null) => {
      const r = await prisma.report.create({ data: { targetType: "REEL", targetId: randomUUID(), reporterId: randomUUID(), reason: "SPAM", status, createdAt, decidedAt } });
      created.reports.push(r.id);
    };
    await report("OPEN", at(10), null);
    await report("UPHELD", at(20), at(5000));
    await report("UPHELD", at(-3 * MS_DAY), at(6000));
    await report("DISMISSED", at(30), at(7000));

    // Gigs: two by X on the day (X's first), one by Y whose earlier gig was published nine days before.
    const category = await prisma.category.findFirstOrThrow();
    const sellerX = randomUUID();
    const sellerY = randomUUID();
    const gig = async (sellerId: string, publishedAt: Date, status: "ACTIVE" | "PAUSED") => {
      const g = await prisma.gig.create({ data: { sellerId, slug: `an-${uniq()}`, title: "Seeded gig", categoryId: category.id, tags: [], status, publishedAt } });
      created.gigs.push(g.id);
    };
    await gig(sellerX, at(1000), "ACTIVE");
    await gig(sellerX, at(2000), "PAUSED");
    await gig(sellerY, at(3000), "ACTIVE");
    await gig(sellerY, at(-9 * MS_DAY), "ACTIVE");

    // Messaging: one conversation started from a gig and one from a profile, three messages on the day.
    const conv = async (gigId: string | null) => {
      const c = await prisma.conversation.create({ data: { pairKey: `${randomUUID()}:${randomUUID()}`, gigId, createdAt: at(100), lastMessageAt: at(100) } });
      created.conversations.push(c.id);
      return c;
    };
    const fromGig = await conv(randomUUID());
    await conv(null);
    await prisma.conversation.create({ data: { pairKey: `${randomUUID()}:${randomUUID()}`, gigId: randomUUID(), createdAt: at(-1), lastMessageAt: at(-1) } }).then((c) => created.conversations.push(c.id));
    for (const when of [at(200), at(300), at(MS_DAY - 1)]) await prisma.message.create({ data: { conversationId: fromGig.id, senderId: randomUUID(), body: "hello", createdAt: when } });
    await prisma.message.create({ data: { conversationId: fromGig.id, senderId: randomUUID(), body: "yesterday", createdAt: at(-1) } });

    // Campaign: 3 sent, 2 opened, 1 clicked on the day; one open lands on the next day.
    const campaign = await prisma.campaign.create({ data: { name: `an-${uniq()}`, subject: "s", bodyMarkdown: "b", segment: {}, createdById: randomUUID() } });
    created.campaigns.push(campaign.id);
    const rec = (over: Record<string, Date | string>) => prisma.campaignRecipient.create({ data: { campaignId: campaign.id, userId: randomUUID(), status: "SENT", ...over } });
    await rec({ sentAt: at(10), openedAt: at(20), clickedAt: at(30) });
    await rec({ sentAt: at(11), openedAt: at(MS_DAY + 5) });
    await rec({ sentAt: at(MS_DAY - 1), openedAt: at(40) });

    // Courses: owner X publishes two on the day (X's first), owner Y one on the day but an earlier one three days before, owner Z one the next day.
    const cat = await prisma.category.findFirstOrThrow();
    const course = async (ownerId: string, publishedAt: Date) => {
      const c = await prisma.course.create({
        data: { ownerType: "USER", ownerId, slug: `an-${uniq()}`, title: "Seeded course", categoryId: cat.id, language: "en", tags: [], status: "PUBLISHED", publishedAt, createdById: ownerId, ownerName: "Seeded" },
      });
      created.courses.push(c.id);
      return c;
    };
    const [ownerX, ownerY, ownerZ] = [randomUUID(), randomUUID(), randomUUID()];
    const courseX = await course(ownerX, at(500));
    await course(ownerX, at(600));
    await course(ownerY, at(-3 * MS_DAY));
    await course(ownerY, at(700));
    await course(ownerZ, at(MS_DAY));
    // Enrolments created on the day (3: first ms, midday, last ms), 1 ms before and the next day's first ms; two completed on the day, one a millisecond before.
    const enrol = (createdAt: Date, completedAt: Date | null = null) => prisma.enrolment.create({ data: { courseId: courseX.id, userId: randomUUID(), source: "FREE", createdAt, completedAt } });
    await enrol(at(0), at(100));
    await enrol(at(12 * 3600_000));
    await enrol(at(MS_DAY - 1), at(MS_DAY - 2));
    await enrol(at(-1), at(-2));
    await enrol(at(MS_DAY));
    // Certificates issued on the day (2), one a millisecond before and one the next day.
    for (const issuedAt of [at(50), at(MS_DAY - 5), at(-1), at(MS_DAY)]) {
      await prisma.certificate.create({ data: { code: `AN-${uniq()}`, courseId: courseX.id, userId: randomUUID(), courseTitle: "Seeded course", issuerName: "Skiller", issuedAt } });
    }

    // Reels: 3 published on the day, 1 ms before and the next day's first ms; views counted on the day (5 + 7) and on the day before (100); 2 comments on the day and 1 a ms before.
    const reel = async (publishedAt: Date) => {
      const r = await prisma.reel.create({ data: { creatorId: randomUUID(), mediaAssetId: randomUUID(), status: "PUBLISHED", publishedAt } });
      created.reels.push(r.id);
      return r;
    };
    const reelA = await reel(at(60));
    const reelB = await reel(at(70));
    await reel(at(MS_DAY - 1));
    await reel(at(-1));
    await reel(at(MS_DAY));
    await prisma.reelViewDaily.createMany({ data: [{ reelId: reelA.id, day, views: 5 }, { reelId: reelB.id, day, views: 7 }, { reelId: reelA.id, day: addDays(day, -1), views: 100 }] });
    for (const createdAt of [at(80), at(90), at(-1)]) await prisma.reelComment.create({ data: { reelId: reelA.id, userId: randomUUID(), body: "nice", createdAt } });

    return { before, first, midday, last, after };
  }

  async function series(keys: string[], from: string, to: string, s: Session = admin) {
    const res = await http().get(`/v1/admin/analytics/series?keys=${keys.join(",")}&from=${from}&to=${to}`).set(auth(s));
    expect(res.status).toBe(200);
    return res.body as { points: Array<{ day: string; values: Record<string, number | string> }>; dataThrough: string | null };
  }
  const valueOn = async (key: string, d: string) => (await series([key], d, d)).points[0].values[key];

  beforeAll(async () => {
    t = await createAuthTestApp({ providers: [TestItemProvider] }, (b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake).overrideProvider(RAZORPAYX_CLIENT).useValue(fakeX));
    prisma = t.app.get(PrismaService);
    rollup = t.app.get(RollupService);
    admin = await t.login();
    await t.app.get(RolesService).grantSystem(admin.userId, "super_admin");
    await stepUp(admin);
  });
  afterAll(async () => {
    if (prisma) {
      await prisma.dailyMetric.deleteMany({ where: { day: { in: [addDays(day, -1), day, addDays(day, 1), addDays(day, 5), addDays(day, 6)] } } });
      await prisma.campaign.deleteMany({ where: { id: { in: created.campaigns } } });
      await prisma.message.deleteMany({ where: { conversationId: { in: created.conversations } } });
      await prisma.conversation.deleteMany({ where: { id: { in: created.conversations } } });
      await prisma.gig.deleteMany({ where: { id: { in: created.gigs } } });
      await prisma.reel.deleteMany({ where: { id: { in: created.reels } } });
      await prisma.certificate.deleteMany({ where: { courseId: { in: created.courses } } });
      await prisma.enrolment.deleteMany({ where: { courseId: { in: created.courses } } });
      await prisma.course.deleteMany({ where: { id: { in: created.courses } } });
      await prisma.report.deleteMany({ where: { id: { in: created.reports } } });
      await prisma.payout.deleteMany({ where: { id: { in: created.payouts } } });
      await prisma.order.deleteMany({ where: { id: { in: created.orders } } });
      await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    }
    await t?.close();
  });

  describe("access", () => {
    it("analytics.view is held by super_admin and finance_admin; members, moderators and anonymous callers are refused on every endpoint", async () => {
      const finance = await t.login();
      await t.app.get(RolesService).grantSystem(finance.userId, "finance_admin");
      const member = await t.login();
      const moderator = await t.login();
      await t.app.get(RolesService).grantSystem(moderator.userId, "moderator");
      const urls = ["overview", "series?keys=signups", "funnel", "export?keys=signups"].map((u) => `/v1/admin/analytics/${u}`);
      for (const url of urls) {
        expect([url, (await http().get(url).set(auth(admin))).status]).toEqual([url, 200]);
        expect([url, (await http().get(url).set(auth(finance))).status]).toEqual([url, 200]);
        for (const s of [member, moderator]) expect([url, (await http().get(url).set(auth(s))).status]).toEqual([url, 403]);
        expect([url, (await http().get(url)).status]).toEqual([url, 401]);
      }
      const role = await prisma.role.findFirstOrThrow({ where: { key: "finance_admin" }, include: { rolePermissions: { include: { permission: true } } } });
      expect(role.rolePermissions.map((p) => p.permission.key)).toContain("analytics.view");
    });

    it("rebuild needs a step-up and analytics.view", async () => {
      const finance = await t.login();
      await t.app.get(RolesService).grantSystem(finance.userId, "finance_admin");
      const body = { from: addDays(day, -2), to: addDays(day, -1) };
      const res = await http().post("/v1/admin/analytics/rebuild").set(auth(finance)).send(body);
      expect([res.status, res.body.error.code]).toEqual([403, "STEP_UP_REQUIRED"]);
      const member = await t.login();
      expect((await http().post("/v1/admin/analytics/rebuild").set(auth(member)).send(body)).status).toBe(403);
    });
  });

  describe("dashboard equals source (Review Focus 5)", () => {
    it("every number for a seeded IST day equals the rows that were seeded, in the series, the overview and the funnel", async () => {
      await seedDay();
      await rollup.rollupDay(day);
      const keys = ["signups", "creators_new", "orders_paid", "gmv_paise", "sellers_first_sale", "payouts_paid_paise", "reports_opened", "reports_upheld", "gigs_published", "first_gig_published", "gig_inquiries", "messages_sent", "campaign_sends", "campaign_opens", "campaign_clicks", "refunds_paise", "platform_revenue_paise", "enrolments", "course_completions", "certificates_issued", "first_course_published", "reels_posted", "reel_views", "reel_comments"];
      const [d] = (await series(keys, day, day)).points;
      expect(d.values).toEqual({
        signups: 3, // first ms, midday, last ms; not 1 ms before nor the next day's first ms
        creators_new: 2,
        orders_paid: 4, // 49,900 + 150,000 + 25,000 + the refunded 30,000
        gmv_paise: "254900",
        sellers_first_sale: 1, // seller A only: B sold five days earlier, C one millisecond earlier
        payouts_paid_paise: "70000",
        reports_opened: 3,
        reports_upheld: 2,
        gigs_published: 3,
        first_gig_published: 1,
        gig_inquiries: 1,
        messages_sent: 3,
        campaign_sends: 3,
        campaign_opens: 2,
        campaign_clicks: 1,
        refunds_paise: "0",
        platform_revenue_paise: "0",
        enrolments: 3, // first ms, midday, last ms; not 1 ms before nor the next day's first ms
        course_completions: 2,
        certificates_issued: 2,
        first_course_published: 1, // owner X only: Y published three days earlier, Z the next day
        reels_posted: 3,
        reel_views: 12, // 5 + 7 counted on the day; the 100 are the day before's
        reel_comments: 2,
      });

      // The neighbouring days got the boundary rows.
      // The previous day holds exactly the rows seeded 1 ms before the boundary (other suites' rows are not on a 2001-2019 date).
      await rollup.rollupDay(addDays(day, -1));
      await rollup.rollupDay(addDays(day, 1));
      const before = (await series(["signups", "creators_new", "orders_paid", "gig_inquiries", "messages_sent"], addDays(day, -1), addDays(day, -1))).points[0].values;
      expect(before).toEqual({ signups: 1, creators_new: 1, orders_paid: 1, gig_inquiries: 1, messages_sent: 1 });
      const next = (await series(["signups", "creators_new", "payouts_paid_paise", "campaign_opens"], addDays(day, 1), addDays(day, 1))).points[0].values;
      expect(next).toEqual({ signups: 1, creators_new: 1, payouts_paid_paise: "11111", campaign_opens: 1 });

      // Overview over the three days adds the days up; money stays a decimal string.
      const overview = await http().get(`/v1/admin/analytics/overview?from=${addDays(day, -1)}&to=${addDays(day, 1)}`).set(auth(admin));
      expect(overview.status).toBe(200);
      const metric = (key: string) => overview.body.metrics.find((m: { key: string }) => m.key === key);
      expect(metric("signups")).toMatchObject({ value: 5, unit: "count", aggregation: "sum" });
      expect(metric("gmv_paise")).toMatchObject({ value: String(77700 + 254900), unit: "paise" });
      expect(overview.body).toMatchObject({ from: addDays(day, -1), to: addDays(day, 1), days: 3, dataThrough: addDays(day, 1) });

      // Funnel: absolute counts for the range, no member data.
      const funnel = await http().get(`/v1/admin/analytics/funnel?from=${day}&to=${day}`).set(auth(admin));
      expect(funnel.status).toBe(200);
      expect(funnel.body.stages).toEqual([
        { key: "signups", label: expect.any(String), count: 3 },
        { key: "creators", label: expect.any(String), count: 2 },
        { key: "first_listing", label: expect.any(String), count: 2 }, // first gig (1) + first course (1)
        { key: "first_sale", label: expect.any(String), count: 1 },
      ]);
      expect(JSON.stringify(funnel.body)).not.toMatch(/@|userId|"id"/);
    });

    it("platform revenue, refunds, payouts and paid subscribers equal the finance summary (the ledger) for today", async () => {
      const today = istDateOf(t.clock.now());
      await paidOrder(t, fake, { pricePaise: 100000n });
      const c = await paidOrder(t, fake, { pricePaise: 40000n });
      const asked = await http().post(`/v1/orders/${c.orderId}/refund-requests`).set(auth(c.buyer)).set("Idempotency-Key", randomUUID()).send({ reason: "Changed my mind" });
      expect(asked.status).toBe(201);
      await http().post(`/v1/admin/refunds/${asked.body.id}/approve`).set(auth(admin)).send({}).expect(200);
      const refund = await prisma.refund.findUniqueOrThrow({ where: { id: asked.body.id }, include: { order: true } });
      await t.app.get(RefundsService).onProcessed({ id: refund.razorpayRefundId!, paymentId: refund.order.razorpayPaymentId, refundIdNote: refund.id });
      const subscriber = await t.login();
      await givePlan(prisma, "USER", subscriber.userId, "pro");

      await rollup.rollupDay(today);
      const summary = (await http().get(`/v1/admin/finance/summary?from=${today}&to=${today}`).set(auth(admin))).body as Record<string, string | number>;
      const [point] = (await series(["platform_revenue_paise", "refunds_paise", "refunds_count", "payouts_paid_paise", "active_paid_subscribers", "orders_paid"], today, today)).points;
      expect(point.values.platform_revenue_paise).toBe(summary.platformRevenuePaise);
      expect(point.values.refunds_paise).toBe(summary.refundsProcessedPaise);
      expect(BigInt(point.values.refunds_paise)).toBeGreaterThanOrEqual(40000n);
      expect(point.values.refunds_count).toBe(summary.refundCount);
      expect(point.values.payouts_paid_paise).toBe(summary.payoutsPaidPaise);
      expect(point.values.active_paid_subscribers).toBe(summary.activePaidSubscribers);
      // orders_paid counts every order paid today, a refunded one included (the finance GMV drops it: its own number).
      const sold = await prisma.order.count({ where: { status: { in: ["PAID", "REFUNDED", "PARTIALLY_REFUNDED"] }, paidAt: { gte: istDayRange(today).from, lt: istDayRange(today).to } } });
      expect(point.values.orders_paid).toBe(sold);
    });
  });

  describe("rerun (idempotent)", () => {
    it("running a day again, or twice at once, overwrites its rows: nothing doubles, a changed source is picked up, levels are not pushed into a past day", async () => {
      const count = () => prisma.dailyMetric.count({ where: { day } });
      const before = await count();
      expect(before).toBeGreaterThan(0);
      const snapshot = await prisma.dailyMetric.findMany({ where: { day }, orderBy: { key: "asc" } });
      await rollup.rollupDay(day);
      await Promise.all([rollup.rollupDay(day), rollup.rollupDay(day)]);
      expect(await count()).toBe(before);
      expect((await prisma.dailyMetric.findMany({ where: { day }, orderBy: { key: "asc" } })).map((r) => [r.key, r.value])).toEqual(snapshot.map((r) => [r.key, r.value]));
      expect(await valueOn("signups", day)).toBe(3);
      // A level (active gigs, paid subscribers) is what it is when the rollup runs: a past day never receives today's.
      const keys = (await prisma.dailyMetric.findMany({ where: { day }, select: { key: true } })).map((r) => r.key);
      expect(keys).not.toContain("gigs_active");
      expect(keys).not.toContain("active_paid_subscribers");
      expect(keys).not.toContain("dau");

      // The source changes: the next run replaces the value, it does not add to it.
      await user(at(9 * 3600_000));
      await rollup.rollupDay(day);
      expect(await valueOn("signups", day)).toBe(4);
      await rollup.rollupDay(day);
      expect(await valueOn("signups", day)).toBe(4);
    });

    it("a rebuild over a range does every day of it, and the same range again changes nothing", async () => {
      const from = addDays(day, -1);
      const to = addDays(day, 1);
      const processor = t.app.get(RollupProcessor);
      const job = { name: ANALYTICS_REBUILD_JOB, data: { from, to } } as never;
      await processor.process(job);
      const first = await prisma.dailyMetric.findMany({ where: { day: { in: [from, day, to] } }, orderBy: [{ day: "asc" }, { key: "asc" }] });
      await processor.process(job);
      const second = await prisma.dailyMetric.findMany({ where: { day: { in: [from, day, to] } }, orderBy: [{ day: "asc" }, { key: "asc" }] });
      expect(second.map((r) => [r.day, r.key, r.value])).toEqual(first.map((r) => [r.day, r.key, r.value]));
      expect(new Set(first.map((r) => r.day))).toEqual(new Set([from, day, to]));
    });
  });

  describe("IST day boundaries", () => {
    it("23:59:59.999 IST belongs to the day, 00:00:00.000 IST to the next; the rollup and the day helpers agree", async () => {
      const lastMs = at(MS_DAY - 1);
      const firstMsNext = at(MS_DAY);
      expect(istDateOf(lastMs)).toBe(day);
      expect(istDateOf(firstMsNext)).toBe(addDays(day, 1));
      expect(lastMs.toISOString().slice(11, 19)).toBe("18:29:59"); // 23:59:59 IST is 18:29:59 UTC
      // The seeded users at -1 ms / +0 / +24h-1 / +24h land on the previous day / the day (both ends) / the next day.
      const inDay = (d: string) => prisma.user.count({ where: { createdAt: { gte: istDayRange(d).from, lt: istDayRange(d).to }, id: { in: created.users } } });
      expect([await inDay(addDays(day, -1)), await inDay(day), await inDay(addDays(day, 1))]).toEqual([1, 4, 1]);
      expect(await valueOn("signups", addDays(day, -1))).toBe(1);
      expect(await valueOn("signups", day)).toBe(await inDay(day));
      expect(await valueOn("signups", addDays(day, 1))).toBe(1);
    });

    it("the nightly job rolls up the IST day before now, whichever UTC date it is", () => {
      const clockNow = t.clock.now();
      expect(rollup.yesterday()).toBe(addDays(istDateOf(clockNow), -1));
    });
  });

  describe("every provider and key", () => {
    it("providers return only catalog keys and together cover the whole catalog (activity keys come from the tracker)", async () => {
      const providers = t.app.get<MetricsProvider[]>(METRICS_PROVIDERS, { strict: false });
      expect(providers.map((p) => p.module).sort()).toEqual(["billing", "courses", "gigs", "growth", "identity", "messaging", "moderation", "rbac", "reels"]);
      const returned = new Set<string>();
      for (const p of providers) for (const point of await p.collect(day)) returned.add(point.key);
      const catalog = new Set(METRIC_KEYS);
      for (const k of returned) expect(catalog.has(k)).toBe(true);
      for (const k of METRIC_KEYS) if (!["dau", "wau", "mau"].includes(k)) expect(returned.has(k)).toBe(true);
    });

    it("rolling up a day with no data writes zeros for every key (so a re-run overwrites stale values)", async () => {
      const empty = "2000-01-02";
      await rollup.rollupDay(empty);
      const rows = await prisma.dailyMetric.findMany({ where: { day: empty } });
      expect(rows.length).toBeGreaterThan(20);
      expect(rows.every((r) => r.value === 0n)).toBe(true);
      await prisma.dailyMetric.deleteMany({ where: { day: empty } });
      await expect(rollup.rollupDay("2026-02-30")).rejects.toThrow(RangeError);
    });
  });

  describe("endpoints", () => {
    it("validates ranges and keys: calendar days, from <= to, at most two years, known metric keys", async () => {
      const get = (q: string) => http().get(`/v1/admin/analytics/${q}`).set(auth(admin));
      for (const q of ["overview?from=2026-02-30", "overview?from=2026-05-02&to=2026-05-01", "overview?from=2024-01-01&to=2026-06-01", "series?keys=signups&from=nope", "funnel?to=2026-13-01"]) {
        const res = await get(q);
        expect([q, res.status, res.body.error.code]).toEqual([q, 400, "ANALYTICS_RANGE_INVALID"]);
      }
      expect((await get("overview?from=2024-11-06&to=2026-11-06")).status).toBe(200); // 731 days
      expect((await get("overview?from=2024-11-05&to=2026-11-06")).status).toBe(400); // 732
      const unknown = await get("series?keys=signups,drop_table");
      expect([unknown.status, unknown.body.error.code]).toEqual([400, "ANALYTICS_UNKNOWN_METRIC"]);
      expect((await get("series")).status).toBe(400);
      expect((await get("export?keys=")).status).toBe(400);
      expect((await get("overview")).body.days).toBe(30); // default: the last 30 days
    });

    it("a day not yet rolled up shows 0 and dataThrough tells how far the rollup goes", async () => {
      const gap = await series(["signups"], addDays(day, 2), addDays(day, 3));
      expect(gap.points.map((p) => p.values.signups)).toEqual([0, 0]);
      expect(gap.dataThrough).toBeNull();
    });

    it("exports the series as CSV: attachment, header row, one row per day, money in paise, no formula can start a cell", async () => {
      const res = await http().get(`/v1/admin/analytics/export?keys=signups,gmv_paise&from=${day}&to=${addDays(day, 1)}`).set(auth(admin));
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/csv/);
      expect(res.headers["content-disposition"]).toBe(`attachment; filename="skiller-analytics-${day}_${addDays(day, 1)}.csv"`);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      // The web app is another origin: it can read the file name only when the API exposes the header.
      const cross = await http().get(`/v1/admin/analytics/export?keys=signups&from=${day}&to=${day}`).set(auth(admin)).set("Origin", "http://localhost:5173");
      expect(cross.headers["access-control-expose-headers"]).toMatch(/Content-Disposition/i);
      const lines = res.text.trim().split("\r\n");
      expect(lines).toEqual(["day,signups,gmv_paise", `${day},4,254900`, `${addDays(day, 1)},1,0`]);
      // Keys are checked against the catalog, so nothing a caller types can reach a cell.
      expect((await http().get(`/v1/admin/analytics/export?keys=${encodeURIComponent("=HYPERLINK(1)")}`).set(auth(admin))).status).toBe(400);
    });

    it("rebuild: validates the range (past days only, 31 at most), queues a background job, and is audited", async () => {
      const post = (body: Record<string, unknown>) => http().post("/v1/admin/analytics/rebuild").set(auth(admin)).send(body);
      const today = istDateOf(t.clock.now());
      for (const body of [{ from: addDays(today, -3), to: today }, { from: addDays(today, -3), to: addDays(today, 1) }, { from: addDays(today, -40), to: addDays(today, -1) }, { from: "2026-02-30", to: "2026-03-01" }, { from: addDays(today, -1), to: addDays(today, -3) }]) {
        const res = await post(body);
        expect([JSON.stringify(body), res.status, res.body.error.code]).toEqual([JSON.stringify(body), 400, "ANALYTICS_RANGE_INVALID"]);
      }
      expect((await post({ from: day, to: day, extra: 1 })).status).toBe(400);
      const range = { from: addDays(day, 5), to: addDays(day, 6) };
      const ok = await post(range);
      expect([ok.status, ok.body]).toEqual([202, { jobId: expect.any(String), ...range }]);
      const queue = t.app.get<Queue>(queueToken(QueueNames.maintenanceLong), { strict: false });
      const job = await queue.getJob(ok.body.jobId);
      expect(job).toBeDefined();
      expect(job!.name).toBe(ANALYTICS_REBUILD_JOB);
      expect(job!.data).toEqual(range);
      const audit = await prisma.auditLog.findMany({ where: { action: "analytics.rebuild", targetId: ok.body.jobId } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: admin.userId, after: range });
      // exactly 31 days is allowed (checked on the range rule; not queued: that would roll up 31 days)
      expect(t.app.get(AnalyticsService).rebuildRange(addDays(day, 10), addDays(day, 40))).toEqual({ from: addDays(day, 10), to: addDays(day, 40) });
      // the worker started by this test app runs the queued job: wait for it before cleaning up
      await until(async () => (await queue.getJob(ok.body.jobId))?.isCompleted());
      expect((await prisma.dailyMetric.count({ where: { day: { in: [range.from, range.to] } } })) > 0).toBe(true);
    });
  });

  describe("activity tracking (AccessGuard)", () => {
    it("an authenticated request records the member; anonymous and refused requests do not; a failing Redis never fails the request", async () => {
      const tracker = t.app.get(ActivityTracker);
      const spy = jest.spyOn(tracker, "record");
      try {
        const member = await t.login();
        expect((await http().get("/v1/conversations/unread-count").set(auth(member))).status).toBe(200);
        expect(spy).toHaveBeenCalledWith(member.userId);
        spy.mockClear();
        expect((await http().get("/v1/conversations/unread-count")).status).toBe(401);
        expect((await http().get("/v1/health")).status).toBe(200);
        expect(spy).not.toHaveBeenCalled();
        // authenticated but without permission is still an active member
        const denied = await http().get("/v1/admin/analytics/overview").set(auth(member));
        expect(denied.status).toBe(403);
        expect(spy).toHaveBeenCalledWith(member.userId);
      } finally {
        spy.mockRestore();
      }

      const redis = t.app.get(REDIS);
      const fresh = await t.login();
      const multi = jest.spyOn(redis, "multi").mockImplementation(() => {
        throw new Error("redis down");
      });
      try {
        const res = await http().get("/v1/conversations/unread-count").set(auth(fresh));
        expect(res.status).toBe(200);
        expect(multi).toHaveBeenCalled();
      } finally {
        multi.mockRestore();
      }
    });

    it("the tracked member shows up in the day's DAU / WAU / MAU after a rollup of that day (approximate counts)", async () => {
      const today = istDateOf(t.clock.now());
      const tracker = t.app.get(ActivityTracker);
      const redis = t.app.get(REDIS);
      const member = await t.login();
      // Today's set is shared with every other suite and approximate, so the member's own write is observed at the PFADD, not inferred from a count.
      const added: string[] = [];
      const original = redis.multi.bind(redis) as (...args: unknown[]) => ReturnType<typeof redis.multi>;
      const spy = jest.spyOn(redis, "multi").mockImplementation(((...args: unknown[]) => {
        const m = original(...args);
        const pfadd = m.pfadd.bind(m);
        m.pfadd = ((key: string, ...members: string[]) => {
          added.push(`${key}|${members.join(",")}`);
          return pfadd(key, ...members);
        }) as typeof m.pfadd;
        return m;
      }) as never);
      try {
        await http().get("/v1/conversations/unread-count").set(auth(member)).expect(200);
      } finally {
        spy.mockRestore();
      }
      expect(added).toContain(`activity:hll:${today}|${member.userId}`); // this member, into today's set
      await until(async () => (await tracker.daily(today)) !== null);
      await rollup.rollupDay(today);
      const [p] = (await series(["dau", "wau", "mau"], today, today)).points;
      expect(Number(p.values.dau)).toBe(await tracker.daily(today)); // the stored number is the set's count
      expect(Number(p.values.dau)).toBeGreaterThanOrEqual(1);
      expect(Number(p.values.wau)).toBeGreaterThanOrEqual(Number(p.values.dau));
      expect(Number(p.values.mau)).toBeGreaterThanOrEqual(Number(p.values.wau));
    });

    it("a rebuild never replaces WAU / MAU with a partial window: a day of the window whose set was lost, or has expired, leaves the stored values alone (I7)", async () => {
      const redis = t.app.get(REDIS);
      const today = istDateOf(t.clock.now());
      const keys: string[] = [];
      const setOf = async (d: string, members: string[]) => {
        const key = `activity:hll:${d}`;
        keys.push(key);
        await redis.pfadd(key, ...members);
      };
      const stored = async (d: string, key: string) => (await prisma.dailyMetric.findUnique({ where: { day_key: { day: d, key } } }))?.value;
      const touchedDays: string[] = [];
      try {
        // (1) a recent day whose set was lost after it had been rolled up: 30 days of one regular plus one visitor a day
        const end = addDays(today, -3);
        const regular = randomUUID();
        for (let i = 0; i < 30; i++) {
          const d = addDays(end, -i);
          touchedDays.push(d);
          await setOf(d, [regular, randomUUID()]);
        }
        const lostDay = addDays(end, -10);
        await rollup.rollupDay(lostDay); // so the lost day is known to have been tracked (it has a dau row)
        await rollup.rollupDay(end);
        expect([await stored(end, "dau"), await stored(end, "wau"), await stored(end, "mau")]).toEqual([2n, 8n, 31n]);
        await redis.del(`activity:hll:${lostDay}`); // the set is gone
        await rollup.rollupDay(end); // a rebuild
        expect(await stored(end, "dau")).toBe(2n);
        expect(await stored(end, "wau")).toBe(8n); // its window is complete: recomputed
        expect(await stored(end, "mau")).toBe(31n); // one day missing: not replaced by the partial 30

        // (2) an old day: its window reaches past the lifetime of the sets, so MAU keeps what the nightly run stored when the sets still existed
        const old = addDays(today, -40);
        for (let i = 0; i < 7; i++) {
          touchedDays.push(addDays(old, -i));
          await setOf(addDays(old, -i), [randomUUID()]);
        }
        await prisma.dailyMetric.createMany({ data: [{ day: old, key: "mau", value: 777n }, { day: old, key: "wau", value: 55n }], skipDuplicates: true });
        await rollup.rollupDay(old);
        expect(await stored(old, "wau")).toBe(7n); // the week is complete: recomputed
        expect(await stored(old, "mau")).toBe(777n); // days 62+ back are gone: kept
      } finally {
        if (keys.length > 0) await redis.del(...keys);
        await prisma.dailyMetric.deleteMany({ where: { day: { in: [...touchedDays, addDays(today, -40)] } } });
      }
    });
  });
});
