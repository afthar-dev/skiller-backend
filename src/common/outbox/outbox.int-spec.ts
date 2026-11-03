import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import { applyTestEnv } from "../../../test/setup/env";
import { ConfigModule } from "../config/config.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
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

    await Promise.all([relay.relayOnce(), relay.relayOnce()]);
    await waitFor(() => seen.includes(userId));
    await relay.relayOnce();
    await sleep(700);

    expect(seen.filter((u) => u === userId)).toHaveLength(1);
    const row = await prisma.outboxEvent.findFirstOrThrow({ where: { payload: { path: ["userId"], equals: userId } } });
    expect(row.publishedAt).not.toBeNull();
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
