import { Test, TestingModule } from "@nestjs/testing";
import type { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { applyTestEnv } from "../../../test/setup/env";
import { ConfigModule } from "../config/config.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { QueueNames, queueToken } from "../queue/queue.constants";
import { QueueModule } from "../queue/queue.module";
import { RedisModule } from "../redis/redis.module";
import { OutboxModule } from "./outbox.module";
import { OutboxRelay } from "./outbox.relay";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BACKLOG = 120;

/**
 * Regression: the relay used to hold an interactive transaction (row locks) open across one Redis call per row, so a backlog of
 * >100 unpublished rows plus slow Redis exceeded the transaction timeout (and held DB locks over network I/O).
 * No worker runs here, so the queue calls are the only thing in flight and the assertions are deterministic.
 */
describe("outbox relay with a large backlog", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let relay: OutboxRelay;
  let queue: Queue;
  const backlogIds: string[] = [];

  beforeAll(async () => {
    applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
    moduleRef = await Test.createTestingModule({ imports: [ConfigModule, PrismaModule, RedisModule, QueueModule.register(), OutboxModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    relay = moduleRef.get(OutboxRelay);
    queue = moduleRef.get<Queue>(queueToken(QueueNames.outbox));
  });

  afterAll(async () => {
    if (backlogIds.length) {
      for (const id of backlogIds) await (await queue.getJob(id))?.remove().catch(() => undefined);
      await prisma.outboxEvent.deleteMany({ where: { id: { in: backlogIds } } });
    }
    await moduleRef?.close();
  });

  it("does not hold row locks or a transaction while talking to Redis, and publishes a backlog larger than a batch", async () => {
    // Older than every other suite's rows, so they are always first in the relay's ORDER BY createdAt.
    const old = new Date("2000-01-01T00:00:00Z");
    for (let i = 0; i < BACKLOG; i++) {
      const id = randomUUID();
      backlogIds.push(id);
      await prisma.outboxEvent.create({
        data: { id, type: "user.registered", payload: { userId: randomUUID(), email: "backlog@example.com" }, createdAt: new Date(old.getTime() + i) },
      });
    }

    let lockProbes = 0;
    const probe = async (ids: string[]) => {
      if (!ids.some((id) => backlogIds.includes(id))) return;
      // NOWAIT fails immediately (55P03) if any other connection still holds the row lock.
      await prisma.$queryRaw`SELECT "id" FROM "outbox_events" WHERE "id" = ${ids.find((id) => backlogIds.includes(id))!} FOR UPDATE NOWAIT`;
      lockProbes += 1;
      await sleep(250);
    };
    const origAdd = queue.add.bind(queue);
    const origBulk = queue.addBulk.bind(queue);
    const addSpy = jest.spyOn(queue, "add").mockImplementation(async (...args: Parameters<Queue["add"]>) => {
      await probe([String(args[2]?.jobId)]);
      return origAdd(...args);
    });
    const bulkSpy = jest.spyOn(queue, "addBulk").mockImplementation(async (jobs: Parameters<Queue["addBulk"]>[0]) => {
      await probe(jobs.map((j) => String(j.opts?.jobId)));
      return origBulk(jobs);
    });
    try {
      const started = Date.now();
      let published = 0;
      while ((await prisma.outboxEvent.count({ where: { id: { in: backlogIds }, publishedAt: null } })) > 0) {
        published += await relay.relayOnce();
        if (Date.now() - started > 60_000) throw new Error("backlog not drained");
      }
      expect(published).toBeGreaterThanOrEqual(BACKLOG);
      expect(lockProbes).toBeGreaterThan(0);
    } finally {
      addSpy.mockRestore();
      bulkSpy.mockRestore();
    }
    const jobs = await Promise.all(backlogIds.map((id) => queue.getJob(id)));
    expect(jobs.every((j) => j !== undefined)).toBe(true);
  }, 90_000);
});
