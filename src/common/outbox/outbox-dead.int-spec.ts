import { Test, TestingModule } from "@nestjs/testing";
import type { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { applyTestEnv } from "../../../test/setup/env";
import { ConfigModule } from "../config/config.module";
import { reportException } from "../observability/sentry";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { QueueNames, queueToken } from "../queue/queue.constants";
import { QueueModule } from "../queue/queue.module";
import { QueueWorkerRunner } from "../queue/queue-worker.runner";
import { RedisModule } from "../redis/redis.module";
import { EventBus } from "./event-bus";
import { OutboxModule } from "./outbox.module";
import { OutboxRelay } from "./outbox.relay";
import { OutboxService } from "./outbox.service";

jest.mock("../observability/sentry", () => ({ ...jest.requireActual("../observability/sentry"), reportException: jest.fn() }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("outbox dead letters", () => {
  let moduleRef: TestingModule;
  let runner: QueueWorkerRunner;

  beforeAll(async () => {
    applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
    moduleRef = await Test.createTestingModule({ imports: [ConfigModule, PrismaModule, RedisModule, QueueModule.register(), OutboxModule] }).compile();
    await moduleRef.init();
    runner = moduleRef.get(QueueWorkerRunner);
    await runner.start();
  });
  afterAll(async () => {
    await runner?.stop();
    await moduleRef?.close();
  });

  it("marks the event dead (deadAt + lastError) and reports to Sentry once every attempt failed", async () => {
    const prisma = moduleRef.get(PrismaService);
    const userId = randomUUID();
    let calls = 0;
    moduleRef.get(EventBus).on("user.registered", async (e) => {
      if (e.userId !== userId) return;
      calls += 1;
      throw new Error("handler down");
    });
    await prisma.$transaction((tx) => moduleRef.get(OutboxService).enqueue(tx, { type: "user.registered", userId, email: "dead@example.com" }));

    // Same job options as production except for the attempt count / delay, so the test does not wait minutes.
    const queue = moduleRef.get<Queue>(queueToken(QueueNames.outbox));
    const find = () => prisma.outboxEvent.findFirstOrThrow({ where: { payload: { path: ["userId"], equals: userId } } });
    const id = (await find()).id;
    const original = queue.addBulk.bind(queue);
    const spy = jest
      .spyOn(queue, "addBulk")
      .mockImplementation((jobs) =>
        original(jobs.map((j) => (j.opts?.jobId === id ? { ...j, opts: { ...j.opts, attempts: 3, backoff: { type: "capped-exponential", delay: 10 } } } : j))),
      );
    try {
      // The shared DB may hold a backlog from other suites; keep relaying (100 oldest rows per batch) until our own event went out.
      const relay = moduleRef.get(OutboxRelay);
      const relayDeadline = Date.now() + 30_000;
      while (!(await find()).publishedAt) {
        if (Date.now() > relayDeadline) throw new Error("event never relayed");
        await relay.relayOnce();
      }
    } finally {
      spy.mockRestore();
    }

    const deadline = Date.now() + 15_000;
    while (!(await find()).deadAt && Date.now() < deadline) await sleep(50);

    const row = await find();
    expect(calls).toBe(3);
    expect(row.deadAt).not.toBeNull();
    expect(row.lastError).toContain("handler down");
    expect(reportException).toHaveBeenCalledWith(expect.objectContaining({ message: "handler down" }), 500);
    // The failed job is retained for inspection / replay.
    const failed = await queue.getFailed();
    expect(failed.some((j) => j.data.id === row.id)).toBe(true);
  });
});
