import { Test } from "@nestjs/testing";
import type { Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { applyTestEnv } from "../../../test/setup/env";
import { FakeClock } from "../../../test/support/fake-clock";
import { CLOCK } from "../../common/clock/clock";
import { ConfigModule } from "../../common/config/config.module";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { OUTBOX_JOB_OPTIONS } from "../../common/queue/queue.options";
import { WebhookDispatcher } from "./webhook.dispatcher";
import { WebhookProcessor, type WebhookJobData } from "./webhook.processor";

describe("WebhookProcessor", () => {
  let prisma: PrismaService;
  let dispatcher: WebhookDispatcher;
  let processor: WebhookProcessor;
  const clock = new FakeClock(new Date("2026-11-03T10:00:00Z"));
  let close: () => Promise<void>;

  beforeAll(async () => {
    applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
    const mod = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
      providers: [WebhookDispatcher, WebhookProcessor, ProcessorRegistry, { provide: CLOCK, useValue: clock }],
    }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    dispatcher = mod.get(WebhookDispatcher);
    processor = mod.get(WebhookProcessor);
    close = () => mod.close();
  });
  afterAll(() => close());

  const make = (type: string, payload: object = { event: type }) =>
    prisma.webhookEvent.create({ data: { provider: "RAZORPAY", eventId: `evt_${randomUUID()}`, bodySha256: randomUUID(), type, payload } });
  const job = (id: string) => ({ data: { webhookEventId: id } }) as Job<WebhookJobData>;

  it("runs on the billing queue with the outbox retry schedule", () => {
    expect(processor.queue).toBe(QueueNames.billing);
    expect(OUTBOX_JOB_OPTIONS.attempts).toBe(15);
  });

  it("dispatches the stored payload, then marks it processed and counts the attempt", async () => {
    const type = `t.${randomUUID()}`;
    const row = await make(type, { event: type, payload: { x: 1 } });
    const seen: unknown[] = [];
    dispatcher.on(type, async (e) => void seen.push(e));
    await processor.process(job(row.id));
    expect(seen).toEqual([{ webhookEventId: row.id, provider: "RAZORPAY", eventId: row.eventId, type, payload: { event: type, payload: { x: 1 } } }]);
    const after = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.processedAt).toEqual(clock.now());
    expect(after.attempts).toBe(1);
    expect(after.lastError).toBeNull();
  });

  it("acknowledges and marks processed an event type nobody handles", async () => {
    const row = await make(`unknown.${randomUUID()}`);
    await processor.process(job(row.id));
    const after = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.processedAt).not.toBeNull();
    expect(after.attempts).toBe(1);
  });

  it("a failing handler is rethrown (so BullMQ retries) with lastError stored and attempts counted; a later success clears it", async () => {
    const type = `flaky.${randomUUID()}`;
    const row = await make(type);
    let fail = true;
    dispatcher.on(type, async () => {
      if (fail) throw new Error("ledger exploded");
    });
    await expect(processor.process(job(row.id))).rejects.toThrow("ledger exploded");
    let after = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ processedAt: null, attempts: 1, lastError: "ledger exploded" });

    fail = false;
    await processor.process(job(row.id));
    after = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ attempts: 2, lastError: null });
    expect(after.processedAt).not.toBeNull();
  });

  it("a redelivered job for a processed event does not run handlers again", async () => {
    const type = `once.${randomUUID()}`;
    const row = await make(type);
    const handler = jest.fn(async () => undefined);
    dispatcher.on(type, handler);
    await processor.process(job(row.id));
    await processor.process(job(row.id));
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } })).attempts).toBe(1);
  });

  it("onExhausted records the final error on an unprocessed event and leaves a processed one alone", async () => {
    const stuck = await make("stuck");
    await processor.onExhausted(job(stuck.id), new Error("gave up"));
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: stuck.id } })).lastError).toBe("gave up");

    const done = await make("done");
    await prisma.webhookEvent.update({ where: { id: done.id }, data: { processedAt: new Date() } });
    await processor.onExhausted(job(done.id), new Error("late"));
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: done.id } })).lastError).toBeNull();
  });

  it("a job whose row is gone fails permanently instead of retrying", async () => {
    await expect(processor.process(job(randomUUID()))).rejects.toMatchObject({ name: "UnrecoverableError" });
  });
});
