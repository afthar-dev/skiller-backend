import { HealthController, READY_CHECK_TIMEOUT_MS, checkWithin } from "./health.controller";

describe("readiness checks have a timeout (DAT-13)", () => {
  afterEach(() => jest.useRealTimers());

  it("checkWithin reports false when the check never answers", async () => {
    jest.useFakeTimers();
    const result = checkWithin(() => new Promise<boolean>(() => undefined), 50);
    await jest.advanceTimersByTimeAsync(60);
    await expect(result).resolves.toBe(false);
  });

  it("checkWithin passes through true and turns failures into false", async () => {
    await expect(checkWithin(async () => true)).resolves.toBe(true);
    await expect(checkWithin(async () => Promise.reject(new Error("x")))).resolves.toBe(false);
    await expect(checkWithin(() => { throw new Error("sync"); })).resolves.toBe(false);
  });

  it("ready() rejects with NOT_READY within the timeout when the database never answers", async () => {
    jest.useFakeTimers();
    const prisma = { $queryRaw: () => new Promise(() => undefined) };
    const redis = { ping: async () => "PONG" };
    const controller = new HealthController(prisma as never, redis as never);
    const outcome = controller.ready().then(() => "ok", (e: { getStatus?: () => number; code?: string }) => e);
    await jest.advanceTimersByTimeAsync(READY_CHECK_TIMEOUT_MS + 10);
    const err = (await outcome) as { status?: number; code?: string };
    expect(err.code).toBe("NOT_READY");
  });
});
