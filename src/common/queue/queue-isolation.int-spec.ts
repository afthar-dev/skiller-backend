import { Test, TestingModule } from "@nestjs/testing";
import type { Job, Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { applyTestEnv } from "../../../test/setup/env";
import { ConfigModule } from "../config/config.module";
import { EventBus } from "../outbox/event-bus";
import { OutboxModule } from "../outbox/outbox.module";
import { OutboxRelay } from "../outbox/outbox.relay";
import { OutboxService } from "../outbox/outbox.service";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { RedisModule } from "../redis/redis.module";
import type { JobProcessor } from "./job-processor";
import { ProcessorRegistry } from "./processor-registry";
import { QueueWorkerRunner } from "./queue-worker.runner";
import { QueueNames, queueToken } from "./queue.constants";
import { QueueModule } from "./queue.module";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("queue isolation", () => {
  let moduleRef: TestingModule;
  let runner: QueueWorkerRunner;
  let release: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  let started = false;

  beforeAll(async () => {
    applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
    moduleRef = await Test.createTestingModule({ imports: [ConfigModule, PrismaModule, RedisModule, QueueModule.register(), OutboxModule] }).compile();
    await moduleRef.init();
    const slow: JobProcessor = {
      queue: QueueNames.maintenance,
      process: async (_job: Job) => {
        started = true;
        await blocked; // like an hourly media cleanup running for minutes
      },
    };
    moduleRef.get(ProcessorRegistry).register(slow);
    runner = moduleRef.get(QueueWorkerRunner);
    await runner.start();
  });

  afterAll(async () => {
    release();
    await runner?.stop();
    await moduleRef?.close();
  });

  it("a long-running maintenance job does not delay the outbox relay", async () => {
    await moduleRef.get<Queue>(queueToken(QueueNames.maintenance)).add("slow", {}, { attempts: 1 });
    const deadline = Date.now() + 10_000;
    while (!started && Date.now() < deadline) await sleep(25);
    expect(started).toBe(true);

    const seen: string[] = [];
    moduleRef.get(EventBus).on("user.registered", async (e) => {
      seen.push(e.userId);
    });
    const userId = randomUUID();
    await moduleRef.get(PrismaService).$transaction((tx) => moduleRef.get(OutboxService).enqueue(tx, { type: "user.registered", userId, email: "iso@example.com" }));
    await moduleRef.get(OutboxRelay).schedule();

    const until = Date.now() + 10_000;
    while (!seen.includes(userId) && Date.now() < until) await sleep(50);
    expect(seen).toContain(userId); // delivered while the maintenance job is still active
  });
});
