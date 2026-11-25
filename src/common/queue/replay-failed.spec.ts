import { replayFailed } from "./replay-failed";

const job = (id: string, failed: boolean) => ({ id, isFailed: async () => failed, retry: jest.fn(async () => undefined) });

describe("replayFailed (DAT-11)", () => {
  it("retries every failed job, or only the named ones, and skips jobs that are not failed", async () => {
    const a = job("a", true);
    const b = job("b", true);
    const c = job("c", false);
    const queue = { getFailed: async () => [a, b], getJob: async (id: string) => ({ a, b, c }[id]) };
    await expect(replayFailed(queue as never)).resolves.toEqual(["a", "b"]);
    expect(a.retry).toHaveBeenCalledWith("failed");
    await expect(replayFailed(queue as never, ["b", "c", "missing"])).resolves.toEqual(["b"]);
  });
});
