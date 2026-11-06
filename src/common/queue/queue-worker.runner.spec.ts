import { Worker } from "bullmq";
import { ProcessorRegistry } from "./processor-registry";
import { QueueWorkerRunner } from "./queue-worker.runner";
import { QueueNames } from "./queue.constants";
import type { JobProcessor } from "./job-processor";
import { OutboxRelay } from "../outbox/outbox.relay";
import { OutboxProcessor } from "../outbox/outbox.processor";

jest.mock("bullmq", () => {
  const instances: { name: string; opts: { concurrency: number; limiter?: { max: number; duration: number } } }[] = [];
  class FakeWorker {
    constructor(
      public name: string,
      public processor: unknown,
      public opts: { concurrency: number; limiter?: { max: number; duration: number } },
    ) {
      instances.push(this);
    }
    on() {
      return this;
    }
    waitUntilReady() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }
  return { Worker: FakeWorker, __instances: instances };
});

const instances = (jest.requireMock("bullmq") as { __instances: { name: string; opts: { concurrency: number; limiter?: { max: number; duration: number } } }[] }).__instances;
const nul = null as never;

describe("QueueWorkerRunner", () => {
  beforeEach(() => {
    instances.length = 0;
  });

  it("starts one Worker per queue with the concurrency of that queue's processor", async () => {
    const registry = new ProcessorRegistry();
    const proc = (queue: JobProcessor["queue"], concurrency?: number): JobProcessor => ({ queue, concurrency, process: async () => undefined });
    registry.register(proc(QueueNames.mediaTranscode, 1));
    registry.register(proc(QueueNames.mediaLight, 4));
    const runner = new QueueWorkerRunner(registry, nul);
    await runner.start();
    expect(Object.fromEntries(instances.map((w) => [w.name, w.opts.concurrency]))).toEqual({ "media-transcode": 1, "media-light": 4 });
    expect(Worker).toBeDefined();
  });

  it("a processor's limiter becomes the Worker's rate limit, and refreshLimiters picks up a changed value without a restart", async () => {
    const registry = new ProcessorRegistry();
    let perSecond = 8;
    registry.register({ queue: QueueNames.mailPromo, process: async () => undefined, limiter: async () => ({ max: perSecond, duration: 1000 }) });
    registry.register({ queue: QueueNames.mail, process: async () => undefined });
    const runner = new QueueWorkerRunner(registry, nul);
    await runner.start();
    const limiterOf = (queue: string) => instances.find((w) => w.name === queue)?.opts.limiter;
    expect(limiterOf("mail-promo")).toEqual({ max: 8, duration: 1000 });
    expect(limiterOf("mail")).toBeUndefined(); // transactional mail is never rate limited
    perSecond = 3;
    await runner.refreshLimiters();
    expect(limiterOf("mail-promo")).toEqual({ max: 3, duration: 1000 });
    await runner.stop();
  });

  it("relay and event dispatch share the outbox queue", () => {
    const relay = new OutboxRelay(nul, nul, nul, nul);
    const dispatch = new OutboxProcessor(nul, nul, nul);
    expect(relay.queue).toBe("outbox");
    expect(dispatch.queue).toBe("outbox");
  });
});
