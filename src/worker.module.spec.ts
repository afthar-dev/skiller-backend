import { WorkerModule } from "./worker.module";

describe("WorkerModule shutdown order (DAT-6)", () => {
  it("stops the queue workers in onModuleDestroy, which runs before Prisma disconnects", async () => {
    const stop = jest.fn(async () => undefined);
    const mod = new (WorkerModule as unknown as new (...a: unknown[]) => WorkerModule)({ stop }, {});
    await mod.onModuleDestroy();
    expect(stop).toHaveBeenCalledTimes(1);
    expect((mod as unknown as Record<string, unknown>).onApplicationShutdown).toBeUndefined();
  });
});
