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
  // Interest weights are updated from it.
  "reel.engaged": true,
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
    // The search index follows renames only if the worker consumes both rename events and ProfilesService can emit them.
    expect(registered).toEqual(expect.arrayContaining(["user.profile_updated", "org.renamed"]));
    const { ProfilesService } = await import("./modules/users");
    expect((app.get(ProfilesService) as unknown as { outbox?: unknown }).outbox).toBeDefined();
    // Profiles read avatar URLs through the media URL resolver, which the worker graph must provide (no Media<->Profiles provider cycle).
    const { MediaUrlResolver } = await import("./modules/media");
    expect(app.get(MediaUrlResolver)).toBeDefined();
    await expect(app.get(ProfilesService).mediaUrls([{ avatarAssetId: null, bannerAssetId: null }])).resolves.toEqual([{ avatarUrl: null, bannerUrl: null }]);
    const expected = Object.entries(HANDLED).filter(([, handled]) => handled).map(([type]) => type).sort();
    expect(registered).toEqual(expected);

    expect(app.get(QueueWorkerRunner).startedQueues.sort()).toEqual(Object.values(QueueNames).sort());
  });

  it("Phase 3: the worker consumes every course event and runs every course job (certificate issuance on course.completed, certificate revocation on order.refunded, seat revocation, search rebuilds on renames, seats sweep, progress recompute, popularity refresh)", async () => {
    const { QueueNames } = await import("./common/queue/queue.constants");
    const { ProcessorRegistry } = await import("./common/queue/processor-registry");
    const { EventBus } = await import("./common/outbox/event-bus");
    const registered = app.get(EventBus).registeredTypes();
    for (const type of ["course.completed", "order.refunded", "org.member_removed", "org.renamed", "user.profile_updated", "order.paid"]) expect(registered).toContain(type);
    const jobs = app.get(ProcessorRegistry).for(QueueNames.maintenance).flatMap((p) => p.jobNames);
    for (const name of ["courses.seats.sweep", "courses.progress.recompute", "courses.popularity.refresh"]) expect(jobs).toContain(name);
  });

  it("Phase 4: the worker publishes a reel when its video is ready and fails it when processing fails (ReelPublisher with the daily limit, attach without the upload machinery)", async () => {
    const { ReelPublisher } = await import("./modules/reels/reel-publisher");
    const { MediaAttachments } = await import("./modules/media");
    expect(app.get(ReelPublisher)).toBeDefined();
    expect(app.get(MediaAttachments)).toBeDefined();
  });

  it("Phase 4: the worker runs every reel handler and job (media.ready publish and media.failed, reel.engaged interest weights, view + link-click flush, trending hashtags) and holds the moderation targets", async () => {
    const { EventBus } = await import("./common/outbox/event-bus");
    const { ProcessorRegistry } = await import("./common/queue/processor-registry");
    const { QueueNames } = await import("./common/queue/queue.constants");
    const { queueToken } = await import("./common/queue/queue.constants");
    const { ModerationTargetRegistry, PostingRestrictions } = await import("./modules/moderation");
    const { NotificationFilters } = await import("./modules/notifications");
    const { ReelViewFlusher } = await import("./modules/reels/reel-view-flusher");
    const { InterestsService } = await import("./modules/reels/interests.service");
    const { ReelNotifier } = await import("./modules/reels/reel-notifier");

    // Events: publish on media.ready (with the posting-ban and daily-limit checks), fail on media.failed, interest weights on reel.engaged.
    expect(app.get(EventBus).registeredTypes()).toEqual(expect.arrayContaining(["media.ready", "media.failed", "reel.engaged"]));
    // Jobs: the minute-by-minute view / link-click flush and the hourly trending-hashtag refresh. Interest decay is lazy (applied on read), so it has no job.
    const jobs = app.get(ProcessorRegistry).for(QueueNames.maintenance).flatMap((p) => p.jobNames);
    expect(jobs).toEqual(expect.arrayContaining(["reels.views.flush", "reels.hashtags.trending", "growth.campaigns.tick"]));
    const keys = (await app.get<import("bullmq").Queue>(queueToken(QueueNames.maintenance)).getJobSchedulers()).map((x) => x.key);
    expect(keys).toEqual(expect.arrayContaining(["reels.views.flush", "reels.hashtags.trending", "growth.campaigns.tick"]));
    // Services those handlers need.
    for (const token of [ReelViewFlusher, InterestsService, ReelNotifier, PostingRestrictions, NotificationFilters]) expect(app.get(token)).toBeDefined();
    // Moderation holds: reels and reel comments are registered so a hide / remove / restore decided in the API stays consistent from the worker too.
    expect(app.get(ModerationTargetRegistry).get("REEL")).toBeDefined();
    expect(app.get(ModerationTargetRegistry).get("REEL_COMMENT")).toBeDefined();
  });

  it("Phase 5-6: the worker runs the campaign sender (tick, the mail-promo worker with its rate limit, Resend event hooks, notifications for a refused start) and the analytics rollup (03:00 IST cron, rebuild job, providers, activity counts)", async () => {
    const { queueToken, QueueNames } = await import("./common/queue/queue.constants");
    const { MailHooks } = await import("./modules/mail");
    const { CampaignSender, PromoMailProcessor } = await import("./modules/growth");
    const { ProcessorRegistry } = await import("./common/queue/processor-registry");
    const { RollupService } = await import("./modules/analytics");
    const { ActivityTracker } = await import("./common/activity/activity-tracker");
    const { METRICS_PROVIDERS } = await import("./modules/analytics/rollup.service");
    const { NotificationsService } = await import("./modules/notifications");
    for (const token of [CampaignSender, RollupService, ActivityTracker, NotificationsService]) expect(app.get(token)).toBeDefined();
    // Promo mail has its own queue and processor, rate limited by the promo_send_per_second setting; the transactional mail queue has none.
    const promo = app.get(PromoMailProcessor);
    expect(app.get(ProcessorRegistry).for(QueueNames.mailPromo)).toEqual([promo]);
    expect(await promo.limiter()).toEqual({ max: 8, duration: 1000 });
    expect(app.get(ProcessorRegistry).for(QueueNames.mail).every((p) => p.limiter === undefined)).toBe(true);
    // The campaign hooks are wired to the mail module in the worker (Resend delivery events reach recipients).
    const hooks = app.get(MailHooks) as unknown as { events: unknown[] };
    expect(hooks.events.length).toBeGreaterThan(0);
    // One provider per module, all built in the worker.
    expect((app.get(METRICS_PROVIDERS) as Array<{ module: string }>).map((x) => x.module).sort()).toEqual(["billing", "courses", "gigs", "growth", "identity", "messaging", "moderation", "rbac", "reels"]);
    const schedulers = await app.get<import("bullmq").Queue>(queueToken(QueueNames.maintenance)).getJobSchedulers();
    expect(schedulers.find((x) => x.key === "analytics.rollup")).toMatchObject({ pattern: "0 3 * * *", tz: "Asia/Kolkata" });
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
      ["analytics.rollup", "courses.popularity.refresh", "courses.seats.sweep", "growth.campaigns.tick", "holds.release", "idempotency.cleanup", "invoices.complete", "media.cleanup", "orders.expire", "payouts.redrive", "reconciliation.nightly", "reels.hashtags.trending", "reels.views.flush", "refunds.resume", "subscriptions.maintain"].sort(),
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
      ["analytics.rebuild", "analytics.rollup", "courses.popularity.refresh", "courses.progress.recompute", "courses.seats.sweep", "growth.campaigns.tick", "holds.release", "idempotency.cleanup", "invoices.complete", "media.cleanup", "orders.expire", "payouts.redrive", "reconciliation.nightly", "reels.hashtags.trending", "reels.views.flush", "refunds.resume", "subscriptions.maintain"].sort(),
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
