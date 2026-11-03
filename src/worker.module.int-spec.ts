import type { INestApplicationContext } from "@nestjs/common";
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
  // Reserved: delivered, no consumer yet (the invite mail is sent directly).
  "org.member_invited": false,
};

describe("WorkerModule boot (src/worker.ts path)", () => {
  let app: INestApplicationContext;

  afterAll(() => app?.close());

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
});
