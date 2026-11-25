import { ProgressService } from "./progress.service";

function setup(addImpl: () => Promise<unknown> = async () => undefined) {
  const flags = new Set<string>();
  const redis = {
    set: jest.fn(async (k: string, _v: string, _ex: string, _t: number, _nx: string) => (flags.has(k) ? null : (flags.add(k), "OK"))),
    del: jest.fn(async (k: string) => void flags.delete(k)),
  };
  const add = jest.fn(async (_n: string, _d: unknown, _o: { jobId: string }) => addImpl());
  const prisma = { enrolment: { findMany: async () => [] } };
  const svc = new ProgressService(prisma as never, null as never, null as never, { now: () => new Date() } as never, { add } as never, redis as never);
  return { svc, add, redis, flags };
}

describe("ProgressService.scheduleRecompute (DAT-2)", () => {
  it("collapses requests made while a job is waiting, but queues again once the run has started (an edit during a run is not lost)", async () => {
    const { svc, add } = setup();
    await svc.scheduleRecompute("c1");
    await svc.scheduleRecompute("c1");
    expect(add).toHaveBeenCalledTimes(1);
    await svc.recomputeInBatches("c1"); // the job starts: flag cleared
    await svc.scheduleRecompute("c1");
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("uses a fresh jobId per run, and failed jobs are not kept, so a failed run never blocks later requests", async () => {
    const { svc, add } = setup();
    await svc.scheduleRecompute("c1");
    await svc.recomputeInBatches("c1");
    await new Promise((r) => setTimeout(r, 2));
    await svc.scheduleRecompute("c1");
    const ids = add.mock.calls.map((c) => (c[2] as { jobId: string }).jobId);
    expect(new Set(ids).size).toBe(2);
    expect((add.mock.calls[0]![2] as { removeOnFail?: boolean }).removeOnFail).toBe(true);
  });

  it("releases the flag when the add fails, so the outbox retry can queue the job", async () => {
    let fail = true;
    const { svc, add } = setup(async () => { if (fail) throw new Error("redis down"); });
    await expect(svc.scheduleRecompute("c1")).rejects.toThrow("redis down");
    fail = false;
    await svc.scheduleRecompute("c1");
    expect(add).toHaveBeenCalledTimes(2);
  });
});
