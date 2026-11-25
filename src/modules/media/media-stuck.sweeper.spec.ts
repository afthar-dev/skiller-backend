import { QueueNames } from "../../common/queue/queue.constants";
import { MAX_SWEEP_REQUEUES, MediaStuckSweeper, STUCK_AFTER_LIGHT_MS, STUCK_AFTER_VIDEO_MS } from "./media-stuck.sweeper";

const NOW = new Date("2026-11-25T12:00:00Z");
const asset = (id: string, purpose: string, ageMs: number, status = "PROCESSING") => ({ id, purpose, status, updatedAt: new Date(NOW.getTime() - ageMs) });

function setup(assets: ReturnType<typeof asset>[], jobs: Record<string, { state: string; data?: { sweep?: number } } | undefined> = {}) {
  const added: { queue: string; data: unknown }[] = [];
  const removed: string[] = [];
  const mkQueue = (name: string) => ({
    getJob: async (id: string) => {
      const j = jobs[id];
      return j ? { data: j.data ?? { assetId: id }, getState: async () => j.state, remove: async () => void removed.push(id) } : undefined;
    },
    add: async (_n: string, data: unknown) => void added.push({ queue: name, data }),
  });
  let served = false;
  const prisma = { mediaAsset: { findMany: async () => (served ? [] : ((served = true), assets)) } };
  const lifecycle = { markFailed: jest.fn(async () => true) };
  const sweeper = new MediaStuckSweeper(prisma as never, lifecycle as never, { register: () => undefined } as never, { now: () => NOW } as never, mkQueue("m") as never, mkQueue(QueueNames.mediaTranscode) as never, mkQueue(QueueNames.mediaTranscodeLong) as never, mkQueue(QueueNames.mediaLight) as never);
  return { sweeper, added, removed, lifecycle };
}

describe("MediaStuckSweeper (DAT-3)", () => {
  it("re-queues an UPLOADED asset that has no job (API died before queue.add), on the queue of its kind", async () => {
    const { sweeper, added } = setup([asset("a", "AVATAR", STUCK_AFTER_LIGHT_MS + 1, "UPLOADED"), asset("l", "COURSE_LESSON", STUCK_AFTER_VIDEO_MS + 1)]);
    await expect(sweeper.process()).resolves.toEqual({ requeued: 2, failed: 0 });
    expect(added).toEqual([
      { queue: QueueNames.mediaLight, data: { assetId: "a", sweep: 1 } },
      { queue: QueueNames.mediaTranscodeLong, data: { assetId: "l", sweep: 1 } },
    ]);
  });

  it("leaves assets with a live job, and assets younger than the threshold of their kind", async () => {
    const { sweeper, added } = setup([asset("a", "AVATAR", STUCK_AFTER_LIGHT_MS + 1), asset("v", "REEL", STUCK_AFTER_LIGHT_MS + 1)], { a: { state: "active" } });
    await expect(sweeper.process()).resolves.toEqual({ requeued: 0, failed: 0 });
    expect(added).toEqual([]);
  });

  it("removes a failed (stalled) job and re-queues it with a counter; after the bound it marks the asset FAILED", async () => {
    const first = setup([asset("v", "REEL", STUCK_AFTER_VIDEO_MS + 1)], { v: { state: "failed" } });
    await first.sweeper.process();
    expect(first.removed).toEqual(["v"]);
    expect(first.added).toEqual([{ queue: QueueNames.mediaTranscode, data: { assetId: "v", sweep: 1 } }]);

    const last = setup([asset("v", "REEL", STUCK_AFTER_VIDEO_MS + 1)], { v: { state: "failed", data: { sweep: MAX_SWEEP_REQUEUES } } });
    await expect(last.sweeper.process()).resolves.toEqual({ requeued: 0, failed: 1 });
    expect(last.lifecycle.markFailed).toHaveBeenCalledWith("v", "PROCESSING_ERROR");
    expect(last.added).toEqual([]);
  });
});
