import type { Redis } from "ioredis";
import request from "supertest";
import { EventBus } from "../../src/common/outbox/event-bus";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { REDIS } from "../../src/common/redis/redis.constants";
import { FakeRazorpayClient, HoldReleaseProcessor, InvoiceIssuer, RAZORPAY_CLIENT } from "../../src/modules/billing";
import { RolesService } from "../../src/modules/rbac";
import { LedgerService } from "../../src/modules/wallet";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import { entryLines, paidOrder } from "../support/orders";
import { TestItemProvider } from "../support/test-item";
import { expectDeclared } from "../support/openapi-shape";

const DAY = 86_400_000;

describe("hold release and invoices", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let bus: EventBus;
  let release: HoldReleaseProcessor;
  let issuer: InvoiceIssuer;
  const fake = new FakeRazorpayClient({ keySecret: "razorpay-key-secret-for-tests", webhookSecret: "razorpay-webhook-secret-for-tests", webhookXSecret: "razorpayx-webhook-secret-for-tests" });
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const pay = (opts: Parameters<typeof paidOrder>[2] = {}) => paidOrder(t, fake, opts);
  // Settings are global to the shared database and cached in Redis: start from the defaults and leave no stored rows behind.
  const resetSettings = async () => {
    const keys = ["hold_days", "platform_gstin", "platform_legal_name", "platform_address", "platform_state_code", "sac_code"];
    await prisma.platformSetting.deleteMany({ where: { key: { in: keys } } });
    await t.app.get<Redis>(REDIS).del(...keys.map((k) => `settings:${k}`));
  };
  // Written straight to the table: SettingsService.set() leaves audit rows that other suites count.
  const setSetting = async (key: string, value: unknown) => {
    await prisma.platformSetting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } });
    await t.app.get<Redis>(REDIS).del(`settings:${key}`);
  };
  const setClock = (to: Date) => t.clock.advance(to.getTime() - t.clock.now().getTime());

  /** The outbox row of a domain event about this order, replayed through the bus like the relay would. */
  async function deliver(type: string, orderId: string) {
    const row = (await prisma.outboxEvent.findMany({ where: { type } })).find((x) => (x.payload as { orderId?: string }).orderId === orderId)!;
    expect(row).toBeDefined();
    await bus.dispatch({ type, ...(row.payload as object) } as Parameters<EventBus["dispatch"]>[0], row.id);
    return row;
  }

  beforeAll(async () => {
    t = await createAuthTestApp({ providers: [TestItemProvider] }, (b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake));
    prisma = t.app.get(PrismaService);
    bus = t.app.get(EventBus);
    release = t.app.get(HoldReleaseProcessor);
    issuer = t.app.get(InvoiceIssuer);
    await resetSettings();
  });
  afterAll(async () => {
    if (t) await resetSettings();
    await t?.close();
  });

  describe("hold release", () => {
    it("moves exactly the seller share booked in the sale entry from PENDING to AVAILABLE, but only once hold_days have passed", async () => {
      const o = await pay();
      const sale = (await entryLines(prisma, o.orderId, "sale"))!;
      const share = sale.byKind.PENDING;
      expect(share).toBeGreaterThan(0n);

      await release.releaseDue();
      expect(await entryLines(prisma, o.orderId, "hold_release")).toBeNull();

      t.clock.advance(7 * DAY - 1000);
      await release.releaseDue();
      expect(await entryLines(prisma, o.orderId, "hold_release")).toBeNull();

      t.clock.advance(2000);
      await release.releaseDue();
      const rel = (await entryLines(prisma, o.orderId, "hold_release"))!;
      expect(rel.entry).toMatchObject({ refType: "ORDER", refId: o.orderId, description: "hold_release" });
      expect(rel.byKind).toEqual({ PENDING: -share, AVAILABLE: share });
      expect(rel.sum).toBe(0n);
      const bal = await t.app.get(LedgerService).balancesFor("USER", o.seller.userId);
      expect(bal.PENDING).toBe(0n);
      expect(bal.AVAILABLE).toBe(share);
    });

    it("uses the PENDING amount of the sale entry, not a recomputation from the order", async () => {
      const o = await pay();
      const share = (await entryLines(prisma, o.orderId, "sale"))!.byKind.PENDING;
      await prisma.order.update({ where: { id: o.orderId }, data: { commissionBps: 5000 } });
      t.clock.advance(8 * DAY);
      await release.releaseDue();
      expect((await entryLines(prisma, o.orderId, "hold_release"))!.byKind.AVAILABLE).toBe(share);
    });

    it("running twice (or concurrently) posts one entry", async () => {
      const o = await pay();
      t.clock.advance(8 * DAY);
      await Promise.all([release.releaseDue(), release.releaseDue()]);
      await release.releaseDue();
      expect(await prisma.journalEntry.count({ where: { refType: "ORDER", refId: o.orderId, description: "hold_release" } })).toBe(1);
      const bal = await t.app.get(LedgerService).balancesFor("USER", o.seller.userId);
      expect(bal.AVAILABLE).toBe((await entryLines(prisma, o.orderId, "sale"))!.byKind.PENDING);
    });

    it("a changed hold_days applies to orders that are not released yet", async () => {
      const o = await pay();
      t.clock.advance(4 * DAY);
      await release.releaseDue();
      expect(await entryLines(prisma, o.orderId, "hold_release")).toBeNull();
      await setSetting("hold_days", 3);
      try {
        await release.releaseDue();
        expect(await entryLines(prisma, o.orderId, "hold_release")).not.toBeNull();
      } finally {
        await resetSettings();
      }
    });

    it("skips orders that are not PAID any more (refunded before release)", async () => {
      const o = await pay();
      await prisma.order.update({ where: { id: o.orderId }, data: { status: "REFUNDED" } });
      t.clock.advance(8 * DAY);
      await release.releaseDue();
      expect(await entryLines(prisma, o.orderId, "hold_release")).toBeNull();
    });

    it("skips an order whose row is locked by someone else instead of waiting for it", async () => {
      const o = await pay();
      t.clock.advance(8 * DAY);
      let releaseLock!: () => void;
      const gate = new Promise<void>((r) => (releaseLock = r));
      let locked!: () => void;
      const hasLock = new Promise<void>((r) => (locked = r));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${o.orderId} FOR UPDATE`;
          locked();
          await gate;
        },
        { timeout: 30_000 },
      );
      await hasLock;
      await release.releaseDue(); // must return without waiting for the held lock
      expect(await entryLines(prisma, o.orderId, "hold_release")).toBeNull();
      releaseLock();
      await holder;
      await release.releaseDue();
      expect(await entryLines(prisma, o.orderId, "hold_release")).not.toBeNull();
    });

    it("keeps the hold while a refund is live (REQUESTED, APPROVED or PROCESSING) and releases on the next run once it is rejected", async () => {
      for (const live of ["REQUESTED", "APPROVED", "PROCESSING"] as const) {
        const o = await pay();
        t.clock.advance(6.9 * DAY);
        const refund = await prisma.refund.create({ data: { orderId: o.orderId, amountPaise: 100000n, status: live, reason: "x", requestedBy: o.buyer.userId } });
        t.clock.advance(1.1 * DAY); // day 8
        await release.releaseDue();
        expect(await entryLines(prisma, o.orderId, "hold_release")).toBeNull();
        await prisma.refund.update({ where: { id: refund.id }, data: { status: "REJECTED" } });
        await release.releaseDue();
        expect(await entryLines(prisma, o.orderId, "hold_release")).not.toBeNull();
      }
    });

    it("a FAILED or PROCESSED refund history of an ordinary order does not hold it (FAILED releases; the order is REFUNDED once processed)", async () => {
      const o = await pay();
      await prisma.refund.create({ data: { orderId: o.orderId, amountPaise: 100000n, status: "FAILED", reason: "x", requestedBy: o.buyer.userId } });
      t.clock.advance(8 * DAY);
      await release.releaseDue();
      expect(await entryLines(prisma, o.orderId, "hold_release")).not.toBeNull();
    });

    it("keeps the hold on an order whose delivery failed, until its refund is REJECTED", async () => {
      const o = await pay();
      await prisma.order.update({ where: { id: o.orderId }, data: { fulfilmentFailedAt: new Date(), fulfilmentError: "X: y" } });
      t.clock.advance(8 * DAY);
      await release.releaseDue();
      expect(await entryLines(prisma, o.orderId, "hold_release")).toBeNull();
      const failed = await prisma.refund.create({ data: { orderId: o.orderId, amountPaise: 100000n, status: "FAILED", reason: "x", requestedBy: "system" } });
      await release.releaseDue();
      expect(await entryLines(prisma, o.orderId, "hold_release")).toBeNull(); // a failed automatic refund still needs a human
      await prisma.refund.update({ where: { id: failed.id }, data: { status: "REJECTED" } });
      await release.releaseDue();
      expect(await entryLines(prisma, o.orderId, "hold_release")).not.toBeNull();
    });

    it("re-checks for a live refund under the order lock (one created between selection and claim)", async () => {
      const o = await pay();
      t.clock.advance(8 * DAY);
      // A refund request lands after the selector listed the order: simulate with a hook on the claim query.
      const original = prisma.$transaction.bind(prisma);
      let injected = false;
      const spy = jest.spyOn(prisma, "$transaction").mockImplementation(((fn: unknown, opts?: unknown) => {
        if (!injected && typeof fn === "function") {
          injected = true;
          return prisma.refund
            .create({ data: { orderId: o.orderId, amountPaise: 100000n, status: "REQUESTED", reason: "late", requestedBy: o.buyer.userId } })
            .then(() => (original as (a: unknown, b?: unknown) => Promise<unknown>)(fn, opts));
        }
        return (original as (a: unknown, b?: unknown) => Promise<unknown>)(fn, opts);
      }) as never);
      try {
        await release.releaseDue();
      } finally {
        spy.mockRestore();
      }
      expect(await entryLines(prisma, o.orderId, "hold_release")).toBeNull();
    });

    it("queues an 'Earnings available' notification for the seller through order.hold_released (once, even if redelivered)", async () => {
      const o = await pay();
      t.clock.advance(8 * DAY);
      await release.releaseDue();
      const row = await deliver("order.hold_released", o.orderId);
      await bus.dispatch({ type: "order.hold_released", ...(row.payload as object) } as Parameters<EventBus["dispatch"]>[0], row.id);
      const notes = await prisma.notification.findMany({ where: { userId: o.seller.userId, type: "earnings.available" } });
      expect(notes).toHaveLength(1);
      expect(notes[0].title).toBe("Earnings available");
    });
  });

  describe("invoice numbers", () => {
    it("are sequential and gap-free across concurrent orders, and restart in a new financial year (April, IST)", async () => {
      // 2031-32 is used by no other test, so the first number of the year is predictable.
      setClock(new Date("2032-03-31T18:00:00Z")); // 23:30 IST on 31 March 2032 -> FY 2031-32
      const orders = await Promise.all([pay(), pay(), pay(), pay()]);
      const issued = await Promise.all(orders.map((o) => issuer.issueForOrder(o.orderId)));
      const numbers = issued.map((i) => i!.number).sort();
      expect(numbers).toEqual([1, 2, 3, 4].map((n) => `SKL/31-32/${String(n).padStart(6, "0")}`));

      setClock(new Date("2032-03-31T18:31:00Z")); // 00:01 IST on 1 April 2032 -> FY 2032-33
      const next = await pay();
      expect((await issuer.issueForOrder(next.orderId))!.number).toBe("SKL/32-33/000001");
      const again = await pay();
      expect((await issuer.issueForOrder(again.orderId))!.number).toBe("SKL/32-33/000002");
    });

    it("issuing the same order twice returns the same invoice", async () => {
      const o = await pay();
      const a = await issuer.issueForOrder(o.orderId);
      const b = await issuer.issueForOrder(o.orderId);
      expect(b!.invoiceId).toBe(a!.invoiceId);
      expect(await prisma.invoice.count({ where: { orderId: o.orderId } })).toBe(1);
    });
  });

  describe("order invoices", () => {
    it("are issued on order.paid, hold the GST breakup of the platform fee and are stored privately as a PDF", async () => {
      const o = await pay({ pricePaise: 100000n, title: "Intro to Rust" });
      await deliver("order.paid", o.orderId);
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { orderId: o.orderId } });
      const sale = (await entryLines(prisma, o.orderId, "sale"))!;
      expect(inv).toMatchObject({ buyerUserId: o.buyer.userId, sellerOwnerId: o.seller.userId, totalPaise: 100000n, taxPaise: sale.byKind.TAX_PAYABLE, objectKey: `invoices/${inv.id}.pdf` });
      expect(inv.number).toHaveLength(16);
      expect(inv.number).toMatch(/^SKL\/\d{2}-\d{2}\/\d{6}$/);
      expect(inv.uploadedAt).not.toBeNull();
      const details = inv.details as { lines: string[] };
      const text = details.lines.join("\n");
      expect(text).toContain("GSTIN: applied for");
      expect(text).toContain("Intro to Rust");
      expect(text).toContain(o.buyer.email);
      expect(text).toContain("1000.00"); // list price and total paid
      expect(text).toMatch(/GST \(18\.00%\) on platform fee/);

      const dl = await http().get(`/v1/invoices/${inv.id}/download`).set(auth(o.buyer));
      expectDeclared(dl, "GET /v1/invoices/{id}/download");
      expect(dl.status).toBe(200);
      expect(dl.body.expiresInSec).toBe(300);
      const pdf = Buffer.from(await (await fetch(dl.body.url)).arrayBuffer());
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    });

    it("print the platform GSTIN when the setting is filled in", async () => {
      await setSetting("platform_gstin", "27AAPFU0939F1ZV");
      try {
        const o = await pay();
        await deliver("order.paid", o.orderId);
        const inv = await prisma.invoice.findUniqueOrThrow({ where: { orderId: o.orderId } });
        const text = (inv.details as { lines: string[] }).lines.join("\n");
        expect(text).toContain("GSTIN: 27AAPFU0939F1ZV");
        expect(text).not.toContain("applied for");
      } finally {
        await resetSettings();
      }
    });

    it("print the platform legal name, address, state code, SAC and the place of supply from the settings", async () => {
      await setSetting("platform_legal_name", "Skiller Learning Pvt Ltd");
      await setSetting("platform_address", "12 Church Street, Bengaluru 560001");
      await setSetting("platform_state_code", "29");
      await setSetting("sac_code", "999293");
      try {
        const o = await pay();
        await deliver("order.paid", o.orderId);
        const inv = await prisma.invoice.findUniqueOrThrow({ where: { orderId: o.orderId } });
        const text = (inv.details as { lines: string[] }).lines.join("\n");
        expect(text).toContain("Skiller Learning Pvt Ltd");
        expect(text).toContain("12 Church Street, Bengaluru 560001");
        expect(text).toContain("SAC: 999293");
        expect(text).toContain("Place of supply: State code 29");
      } finally {
        await resetSettings();
      }
    });

    it("are also issued for a paid order whose delivery failed (order.fulfilment_failed)", async () => {
      const o = await pay();
      await prisma.order.update({ where: { id: o.orderId }, data: { fulfilmentFailedAt: new Date(), fulfilmentError: "X: y" } });
      const row = await prisma.outboxEvent.create({
        data: { type: "order.fulfilment_failed", payload: { orderId: o.orderId, buyerId: o.buyer.userId, itemType: "TEST_ITEM", itemId: o.itemId, itemTitle: "Test course", totalPaise: "100000", error: "X: y" } },
      });
      await bus.dispatch({ type: "order.fulfilment_failed", ...(row.payload as object) } as Parameters<EventBus["dispatch"]>[0], row.id);
      expect(await prisma.invoice.count({ where: { orderId: o.orderId } })).toBe(1);
    });

    it("finishes a missing upload on the next issue call (retry after a storage failure)", async () => {
      const o = await pay();
      const first = await issuer.issueForOrder(o.orderId);
      await prisma.invoice.update({ where: { id: first!.invoiceId }, data: { uploadedAt: null } });
      const dl = await http().get(`/v1/invoices/${first!.invoiceId}/download`).set(auth(o.buyer));
      expect(dl.status).toBe(409);
      expect(dl.body.error.code).toBe("INVOICE_NOT_READY");
      await issuer.issueForOrder(o.orderId);
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: first!.invoiceId } })).uploadedAt).not.toBeNull();
      expect((await http().get(`/v1/invoices/${first!.invoiceId}/download`).set(auth(o.buyer))).status).toBe(200);
    });
  });

  describe("subscription invoices", () => {
    it("are issued for a subscription charge (subscription.changed with a paymentId), once per payment", async () => {
      const owner = await t.login();
      const version = await prisma.planVersion.findFirstOrThrow({ where: { plan: { key: "pro" }, interval: "MONTH" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      const sub = await prisma.subscription.create({ data: { ownerType: "USER", ownerId: owner.userId, planVersionId: version.id, status: "ACTIVE", notifyUserId: owner.userId, currentPeriodEnd: new Date(Date.now() + 30 * DAY) } });
      const paymentId = `pay_sub_${Math.random().toString(36).slice(2, 12)}`;
      const ledger = t.app.get(LedgerService);
      const accounts = await prisma.ledgerAccount.findMany({ where: { ownerType: "PLATFORM", kind: { in: ["GATEWAY_CLEARING", "PLATFORM_REVENUE", "TAX_PAYABLE"] } } });
      const id = (k: string) => accounts.find((a) => a.kind === k)!.id;
      await prisma.$transaction((tx) =>
        ledger.post(tx, {
          refType: "SUBSCRIPTION_CHARGE",
          refId: paymentId,
          description: "Subscription charge",
          lines: [
            { accountId: id("GATEWAY_CLEARING"), amountPaise: -99900n },
            { accountId: id("PLATFORM_REVENUE"), amountPaise: 84661n },
            { accountId: id("TAX_PAYABLE"), amountPaise: 15239n },
          ],
        }),
      );
      const event = { type: "subscription.changed" as const, subscriptionId: sub.id, ownerType: "USER" as const, ownerId: owner.userId, planKey: "pro", planVersionId: version.id, status: "ACTIVE", change: "renewed" as const, paymentId, notifyUserId: owner.userId };
      await bus.dispatch(event, "evt-1");
      await bus.dispatch(event, "evt-1");
      const rows = await prisma.invoice.findMany({ where: { paymentId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ subscriptionId: sub.id, buyerUserId: owner.userId, totalPaise: 99900n, taxPaise: 15239n });
      expect(rows[0].uploadedAt).not.toBeNull();
      expect((await http().get(`/v1/invoices/${rows[0].id}/download`).set(auth(owner))).status).toBe(200);

      // a subscription.changed without a payment (cancel, expiry...) never produces an invoice
      const before = await prisma.invoice.count();
      await bus.dispatch({ ...event, change: "cancel_requested", paymentId: undefined }, "evt-2");
      expect(await prisma.invoice.count()).toBe(before);
    });
  });

  describe("GET /v1/invoices/:id/download", () => {
    it("is allowed for the buyer, the seller and billing.view_any; any other user gets 404; anonymous 401", async () => {
      const o = await pay();
      const inv = (await issuer.issueForOrder(o.orderId))!;
      const url = `/v1/invoices/${inv.invoiceId}/download`;
      expect((await http().get(url).set(auth(o.buyer))).status).toBe(200);
      expect((await http().get(url).set(auth(o.seller))).status).toBe(200);
      const finance = await t.login();
      expect((await http().get(url).set(auth(finance))).status).toBe(404);
      await t.app.get(RolesService).grantSystem(finance.userId, "finance_admin");
      expect((await http().get(url).set(auth(finance))).status).toBe(200);
      const stranger = await t.login();
      const res = await http().get(url).set(auth(stranger));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("INVOICE_NOT_FOUND");
      expect((await http().get(`/v1/invoices/00000000-0000-7000-8000-000000000000/download`).set(auth(stranger))).status).toBe(404);
      expect((await http().get(url)).status).toBe(401);
    });

    it("the order exposes its invoice id to the buyer", async () => {
      const o = await pay();
      const inv = (await issuer.issueForOrder(o.orderId))!;
      const res = await http().get(`/v1/orders/${o.orderId}`).set(auth(o.buyer));
      expect(res.body.invoiceId).toBe(inv.invoiceId);
    });
  });
});
