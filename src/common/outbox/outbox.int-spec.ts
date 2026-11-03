import { Test, TestingModule } from "@nestjs/testing";
import type { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { applyTestEnv } from "../../../test/setup/env";
import { ConfigModule } from "../config/config.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { removeAllSchedulers } from "../../../test/support/schedulers";
import { queueToken, QueueNames } from "../queue/queue.constants";
import { QueueModule } from "../queue/queue.module";
import { QueueWorkerRunner } from "../queue/queue-worker.runner";
import { RedisModule } from "../redis/redis.module";
import { EventBus } from "./event-bus";
import { OutboxModule } from "./outbox.module";
import { OutboxRelay } from "./outbox.relay";
import { OutboxService } from "./outbox.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 15_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(50);
  }
}

/** Other suites share the DB, so a single 100-row batch may not contain our event: relay until it is published. */
async function relayUntilPublished(prisma: PrismaService, id: string, relay: () => Promise<unknown>) {
  const start = Date.now();
  while (!(await prisma.outboxEvent.findUniqueOrThrow({ where: { id } })).publishedAt) {
    if (Date.now() - start > 30_000) throw new Error(`event ${id} never published`);
    await relay();
  }
}

describe("outbox", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let outbox: OutboxService;
  let relay: OutboxRelay;
  let bus: EventBus;
  let runner: QueueWorkerRunner;
  const seen: string[] = [];
  let failOnce: string | null = null;

  beforeAll(async () => {
    applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule, RedisModule, QueueModule.register(), OutboxModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    outbox = moduleRef.get(OutboxService);
    relay = moduleRef.get(OutboxRelay);
    bus = moduleRef.get(EventBus);
    bus.on("user.registered", async (e) => {
      if (failOnce === e.userId) {
        failOnce = null;
        throw new Error("boom");
      }
      seen.push(e.userId);
    });
    runner = moduleRef.get(QueueWorkerRunner);
    await runner.start();
  });

  afterAll(async () => {
    await removeAllSchedulers(moduleRef);
    await runner?.stop();
    await moduleRef?.close();
  });

  it("never relays an event enqueued in a rolled-back transaction", async () => {
    const userId = randomUUID();
    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.enqueue(tx, { type: "user.registered", userId, email: "rollback@example.com" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    await relay.relayOnce();
    await sleep(500);
    expect(seen).not.toContain(userId);
    const rows = await prisma.outboxEvent.count({ where: { payload: { path: ["userId"], equals: userId } } });
    expect(rows).toBe(0);
  });

  it("delivers a committed event exactly once even when the relay runs twice concurrently", async () => {
    const userId = randomUUID();
    await prisma.$transaction((tx) => outbox.enqueue(tx, { type: "user.registered", userId, email: "ok@example.com" }));
    const row = await prisma.outboxEvent.findFirstOrThrow({ where: { payload: { path: ["userId"], equals: userId } } });

    await relayUntilPublished(prisma, row.id, () => Promise.all([relay.relayOnce(), relay.relayOnce()]));
    await waitFor(() => seen.includes(userId));
    await relay.relayOnce();
    await sleep(700);

    expect(seen.filter((u) => u === userId)).toHaveLength(1);
    const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.publishedAt).not.toBeNull();
    expect(after.attempts).toBe(1);
  });

  it("relay lock: concurrent relays enqueue each event exactly once and publish it once", async () => {
    const userId = randomUUID();
    await prisma.$transaction((tx) => outbox.enqueue(tx, { type: "user.registered", userId, email: "lock@example.com" }));
    const row = await prisma.outboxEvent.findFirstOrThrow({ where: { payload: { path: ["userId"], equals: userId } } });

    // Slow only OUR job so the two relays overlap on it; claimed rows must be invisible to the other relay meanwhile.
    const queue = moduleRef.get<Queue>(queueToken(QueueNames.outbox));
    const originalBulk = queue.addBulk.bind(queue);
    const originalAdd = queue.add.bind(queue);
    const bulkSpy = jest.spyOn(queue, "addBulk").mockImplementation(async (jobs: Parameters<Queue["addBulk"]>[0]) => {
      if (jobs.some((j) => j.opts?.jobId === row.id)) await sleep(300);
      return originalBulk(jobs);
    });
    const addSpy = jest.spyOn(queue, "add").mockImplementation(async (...args: Parameters<Queue["add"]>) => {
      if (args[2]?.jobId === row.id) await sleep(300);
      return originalAdd(...args);
    });
    try {
      await relayUntilPublished(prisma, row.id, () => Promise.all([relay.relayOnce(), relay.relayOnce()]));
      const ours = [...bulkSpy.mock.calls.flatMap((c) => c[0]), ...addSpy.mock.calls.map((c) => ({ opts: c[2] }))].filter((j) => j.opts?.jobId === row.id);
      expect(ours).toHaveLength(1);
    } finally {
      bulkSpy.mockRestore();
      addSpy.mockRestore();
    }

    const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.publishedAt).not.toBeNull();
    expect(after.attempts).toBe(1);
    expect(after.claimToken).not.toBeNull();
    await waitFor(() => seen.includes(userId));
    expect(seen.filter((u) => u === userId)).toHaveLength(1);
  });

  it("reclaims a row whose relay crashed after claiming it (claim older than 60 s), and not before", async () => {
    const userId = randomUUID();
    await prisma.$transaction((tx) => outbox.enqueue(tx, { type: "user.registered", userId, email: "crash@example.com" }));
    const row = await prisma.outboxEvent.findFirstOrThrow({ where: { payload: { path: ["userId"], equals: userId } } });
    const claimedAt = (agoMs: number) => prisma.outboxEvent.update({ where: { id: row.id }, data: { claimedAt: new Date(Date.now() - agoMs), claimToken: "dead-relay" } });

    await claimedAt(10_000); // fresh claim by a (possibly live) relay: untouchable
    for (let i = 0; i < 3; i++) await relay.relayOnce();
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } })).publishedAt).toBeNull();

    await claimedAt(61_000); // stale: some relay takes it over
    await relayUntilPublished(prisma, row.id, () => relay.relayOnce());
    await waitFor(() => seen.includes(userId));
    expect(seen.filter((u) => u === userId)).toHaveLength(1);
  });

  it("retries when a handler fails", async () => {
    const userId = randomUUID();
    failOnce = userId;
    await prisma.$transaction((tx) => outbox.enqueue(tx, { type: "user.registered", userId, email: "retry@example.com" }));
    await relay.relayOnce();
    await waitFor(() => seen.includes(userId));
    expect(seen.filter((u) => u === userId)).toHaveLength(1);
  });

  it("relays automatically once scheduled", async () => {
    const userId = randomUUID();
    await relay.schedule();
    await prisma.$transaction((tx) => outbox.enqueue(tx, { type: "user.registered", userId, email: "auto@example.com" }));
    await waitFor(() => seen.includes(userId));
    expect(seen).toContain(userId);
  });
});
