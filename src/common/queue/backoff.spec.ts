import { OUTBOX_BACKOFF_CAP_MS, OUTBOX_JOB_OPTIONS, cappedExponentialBackoff } from "./queue.options";

describe("outbox retry policy", () => {
  it("15 attempts, exponential from 1 s, capped at 30 min, failed jobs kept", () => {
    expect(OUTBOX_JOB_OPTIONS.attempts).toBe(15);
    expect(OUTBOX_JOB_OPTIONS.backoff).toEqual({ type: "capped-exponential", delay: 1000 });
    expect(OUTBOX_JOB_OPTIONS.removeOnFail).toBe(false);
    expect(OUTBOX_BACKOFF_CAP_MS).toBe(30 * 60 * 1000);
    const delays = Array.from({ length: 14 }, (_, i) => cappedExponentialBackoff(i + 1, 1000));
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(Math.max(...delays)).toBe(30 * 60 * 1000);
    expect(delays[13]).toBe(30 * 60 * 1000);
  });
});
