import { QueueNames } from "../../common/queue/queue.constants";
import { FileProcessor } from "./file.processor";
import { ImageProcessor } from "./image.processor";
import { MediaCleanupProcessor } from "./media-cleanup.processor";
import { TranscodeProcessor } from "./transcode.processor";

const nul = null as never;

// BullMQ cannot filter by job name, so each workload gets its own queue (and Worker concurrency).
describe("media queues", () => {
  it("transcodes run alone on their own queue; images and files share a light queue at concurrency 4; cleanup is on maintenance", () => {
    const transcode = new TranscodeProcessor(nul, nul, nul, nul, nul);
    const image = new ImageProcessor(nul, nul, nul, nul);
    const file = new FileProcessor(nul, nul, nul, nul);
    const cleanup = new MediaCleanupProcessor(nul, nul, nul, nul, nul);

    expect(transcode.queue).toBe(QueueNames.mediaTranscode);
    expect(transcode.concurrency).toBe(1);
    expect([image.queue, file.queue]).toEqual([QueueNames.mediaLight, QueueNames.mediaLight]);
    expect(Math.max(image.concurrency, file.concurrency)).toBe(4);
    expect(cleanup.queue).toBe(QueueNames.maintenance);
  });
});
