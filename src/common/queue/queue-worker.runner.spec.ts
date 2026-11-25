import { DelayedError, Worker } from "bullmq";
import { ProcessorRegistry } from "./processor-registry";
import { QueueWorkerRunner, UNKNOWN_JOB_GIVE_UP_MS } from "./queue-worker.runner";
import { QueueNames } from "./queue.constants";
import type { JobProcessor } from "./job-processor";
import { OutboxRelay } from "../outbox/outbox.relay";
import { OutboxProcessor } from "../outbox/outbox.processor";

type Opts = { concurrency: number; maxStalledCount?: number; limiter?: { max: number; duration: number } };
type Instance = { name: string; processor: (job: unknown, token?: string) => Promise<unknown>; opts: Opts; handlers: Record<string, (...a: unknown[]) => void> };

jest.mock("bullmq", () => {
  const actual = jest.requireActual("bullmq");
  const instances: unknown[] = [];
  class FakeWorker {
    handlers: Record<string, (...a: unknown[]) => void> = {};
    constructor(
      public name: string,
      public processor: unknown,
      public opts: unknown,
    ) {
      instances.push(this);
    }
    on(event: string, fn: (...a: unknown[]) => void) {
      this.handlers[event] = fn;
      return this;
    }
    waitUntilReady() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }
  return { ...actual, Worker: FakeWorker, __instances: instances };
});

const instances = (jest.requireMock("bullmq") as { __instances: Instance[] }).__instances;
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

  describe("jobs no processor knows (DAT-5)", () => {
    const start = async () => {
      const registry = new ProcessorRegistry();
      registry.register({ queue: QueueNames.maintenance, jobNames: ["known"], process: async () => "ran" });
      const runner = new QueueWorkerRunner(registry, nul);
      await runner.start();
      return instances[0];
    };
    const job = (name: string, ageMs = 0) => ({ id: "1", name, timestamp: Date.now() - ageMs, moveToDelayed: jest.fn(async () => undefined) });

    it("does not complete it: it is moved back to delayed (no attempt used) and the processor throws DelayedError", async () => {
      const worker = await start();
      const j = job("brand-new-job");
      await expect(worker.processor(j, "tok")).rejects.toBeInstanceOf(DelayedError);
      expect(j.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "tok");
    });

    it("still runs a job it knows", async () => {
      const worker = await start();
      await expect(worker.processor(job("known"), "tok")).resolves.toBeUndefined();
    });

    it("fails (and so is kept as failed) once it is older than the give-up age", async () => {
      const worker = await start();
      const j = job("typo", UNKNOWN_JOB_GIVE_UP_MS + 1000);
      await expect(worker.processor(j, "tok")).rejects.toThrow(/no processor for job typo/);
      expect(j.moveToDelayed).not.toHaveBeenCalled();
    });
  });

  describe("stalled jobs (DAT-3)", () => {
    it("a job BullMQ failed for stalling too often reaches onExhausted even with attempts left; the queue gets the highest maxStalledCount", async () => {
      const registry = new ProcessorRegistry();
      const onExhausted = jest.fn(async () => undefined);
      registry.register({ queue: QueueNames.mediaTranscode, maxStalledCount: 3, process: async () => undefined, onExhausted });
      const runner = new QueueWorkerRunner(registry, nul);
      await runner.start();
      expect(instances[0].opts.maxStalledCount).toBe(3);
      const j = { id: "9", name: "x", attemptsMade: 0, opts: { attempts: 2 } };
      instances[0].handlers.failed(j, new Error("job stalled more than allowable limit"));
      await new Promise((r) => setImmediate(r));
      expect(onExhausted).toHaveBeenCalledTimes(1);
      onExhausted.mockClear();
      instances[0].handlers.failed(j, new Error("boom"));
      await new Promise((r) => setImmediate(r));
      expect(onExhausted).not.toHaveBeenCalled();
    });
  });

  it("relay and event dispatch share the outbox queue", () => {
    const relay = new OutboxRelay(nul, nul, nul, nul);
    const dispatch = new OutboxProcessor(nul, nul, nul);
    expect(relay.queue).toBe("outbox");
    expect(dispatch.queue).toBe("outbox");
  });
});
