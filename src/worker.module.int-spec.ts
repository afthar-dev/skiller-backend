import type { INestApplicationContext } from "@nestjs/common";
import { removeAllSchedulers } from "../test/support/schedulers";
import { applyTestEnv } from "../test/setup/env";
import type { DomainEventType } from "./common/outbox/events";

// Event types the worker must consume today. Every type must be listed in exactly one of the two groups, so adding an
// event to the DomainEvent union fails to compile here until someone decides who handles it.
const HANDLED: Record<DomainEventType, boolean> = {
  "user.registered": true,
  "media.ready": true,
  "media.failed": true,
  "role.granted": true,
  "rbac.permissions_changed": true,
  "user.became_creator": true,
  "org.created": true,
  "org.member_removed": true,
  "org.renamed": true,
  "user.profile_updated": true,
  "subscription.changed": true,
  "order.paid": true,
  "order.fulfilment_failed": true,
  "order.hold_released": true,
  "order.refunded": true,
  "payout.requested": true,
  "payout.approved": true,
  "payout.rejected": true,
  "payout.settled": true,
  "payout.failed": true,
  "payout_account.changed": true,
  // Reserved: delivered, no consumer yet (the invite mail is sent directly).
  "org.member_invited": false,
  // Reserved: the search index and feeds consume it in a later task.
  "course.published": false,
  // Certificates are issued on it.
  "course.completed": true,
};

describe("WorkerModule boot (src/worker.ts path)", () => {
  let app: INestApplicationContext;

  afterAll(async () => {
    if (app) await removeAllSchedulers(app); // createWorker() schedules the outbox relay and media cleanup in the shared Redis
    await app?.close();
  });

  it("createWorker() compiles the real module graph, registers every outbox handler and starts every queue worker", async () => {
    applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
    const { createWorker } = await import("./create-worker");
    const { EventBus } = await import("./common/outbox/event-bus");
    const { QueueWorkerRunner } = await import("./common/queue/queue-worker.runner");
    const { QueueNames } = await import("./common/queue/queue.constants");
    app = await createWorker();

    const registered = app.get(EventBus).registeredTypes().sort();
    const expected = Object.entries(HANDLED).filter(([, handled]) => handled).map(([type]) => type).sort();
    expect(registered).toEqual(expected);

    expect(app.get(QueueWorkerRunner).startedQueues.sort()).toEqual(Object.values(QueueNames).sort());
  });

  it("registers the COURSE sellable and its refund rule in the worker: webhook-first fulfilment runs here", async () => {
    const { SellableRegistry, RefundEligibilityRegistry } = await import("./modules/billing");
    const provider = app.get(SellableRegistry).find("COURSE");
    expect(provider).toBeDefined();
    expect(provider!.type).toBe("COURSE");
    const rule = app.get(RefundEligibilityRegistry).forType("COURSE");
    expect(rule.constructor.name).toBe("CourseRefundEligibility");
    expect(app.get(RefundEligibilityRegistry).forType("TEST_ITEM").constructor.name).toBe("DefaultRefundEligibility");
  });

  it("schedules every repeatable job: outbox relay, media cleanup, order expiry, idempotency cleanup, grace expiry, hold release, invoices, refunds, payouts re-drive, reconciliation", async () => {
    const { queueToken, QueueNames } = await import("./common/queue/queue.constants");
    const keys = async (name: string) =>
      (await app.get<import("bullmq").Queue>(queueToken(name as never)).getJobSchedulers()).map((x) => x.key).sort();
    expect(await keys(QueueNames.outbox)).toEqual(["outbox-relay"]);
    expect(await keys(QueueNames.maintenance)).toEqual(
      ["courses.popularity.refresh", "courses.seats.sweep", "holds.release", "idempotency.cleanup", "invoices.complete", "media.cleanup", "orders.expire", "payouts.redrive", "reconciliation.nightly", "refunds.resume", "subscriptions.maintain"].sort(),
    );
    const nightly = (await app.get<import("bullmq").Queue>(queueToken(QueueNames.maintenance)).getJobSchedulers()).find((x) => x.key === "reconciliation.nightly");
    expect(nightly).toMatchObject({ pattern: "0 2 * * *", tz: "Asia/Kolkata" });
  });

  it("registers a processor for every job name, per queue (webhook dispatcher, payout send, hold release, invoices and credit notes, re-drive, reconciliation, grace expiry, order expiry, idempotency cleanup)", async () => {
    const { ProcessorRegistry } = await import("./common/queue/processor-registry");
    const { QueueNames } = await import("./common/queue/queue.constants");
    const registry = app.get(ProcessorRegistry);
    const jobs = (queue: string) => registry.for(queue as never).flatMap((p) => p.jobNames).sort();
    expect(jobs(QueueNames.billing)).toEqual(["payout.send", "webhook.process"]);
    expect(jobs(QueueNames.maintenance)).toEqual(
      ["courses.popularity.refresh", "courses.progress.recompute", "courses.seats.sweep", "holds.release", "idempotency.cleanup", "invoices.complete", "media.cleanup", "orders.expire", "payouts.redrive", "reconciliation.nightly", "refunds.resume", "subscriptions.maintain"].sort(),
    );
  });

  it("registers a webhook handler for every Razorpay and RazorpayX event the platform acts on", async () => {
    const { WebhookDispatcher } = await import("./modules/billing");
    expect(app.get(WebhookDispatcher).registeredTypes().sort()).toEqual(
      [
        "fund_account.validation.completed",
        "fund_account.validation.failed",
        "payment.captured",
        "payment.failed",
        "payout.failed",
        "payout.processed",
        "payout.rejected",
        "payout.reversed",
        "refund.failed",
        "refund.processed",
        "subscription.activated",
        "subscription.cancelled",
        "subscription.charged",
        "subscription.completed",
        "subscription.halted",
        "subscription.pending",
      ].sort(),
    );
  });
});
