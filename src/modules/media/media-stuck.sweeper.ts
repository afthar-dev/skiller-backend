import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { MediaAsset } from "@prisma/client";
import type { Job, Queue } from "bullmq";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames, type QueueName } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { enqueueMediaJob, queueNameFor, type MediaJobData } from "./media-jobs";
import { MediaLifecycle } from "./media-lifecycle";
import { MEDIA_RULES } from "./media.rules";

export const MEDIA_STUCK_SWEEP_JOB = "media.stuck-sweep";
const SWEEP_EVERY_MS = 15 * 60 * 1000;
/** An image or file is done in seconds; a video may wait behind others on the single transcode worker for hours. */
export const STUCK_AFTER_LIGHT_MS = 30 * 60 * 1000;
export const STUCK_AFTER_VIDEO_MS = 6 * 60 * 60 * 1000;
/** The sweep re-queues an asset this many times; after that the asset is failed (and its owner told) rather than retried for ever. */
export const MAX_SWEEP_REQUEUES = 3;
const BATCH_SIZE = 100;
const LIVE_STATES = new Set(["active", "waiting", "delayed", "prioritized", "waiting-children"]);

/**
 * Backstop for assets that were never finished (DAT-3): a worker killed too often mid-transcode, or an API that died between the PENDING -> UPLOADED flip and
 * the queue add. An UPLOADED / PROCESSING asset with no live job is queued again (bounded); one that keeps coming back is marked FAILED, which emits
 * media.failed (the owner is told, a reel fails) and frees the storage quota (FAILED is not counted).
 */
@Injectable()
export class MediaStuckSweeper implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.maintenance;
  readonly jobNames = [MEDIA_STUCK_SWEEP_JOB];
  private readonly logger = new Logger(MediaStuckSweeper.name);
  private readonly queues: Partial<Record<QueueName, Queue>>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: MediaLifecycle,
    private readonly registry: ProcessorRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
    @InjectQueue(QueueNames.mediaTranscode) transcodeQueue: Queue,
    @InjectQueue(QueueNames.mediaTranscodeLong) transcodeLongQueue: Queue,
    @InjectQueue(QueueNames.mediaLight) lightQueue: Queue,
  ) {
    this.queues = { [QueueNames.mediaTranscode]: transcodeQueue, [QueueNames.mediaTranscodeLong]: transcodeLongQueue, [QueueNames.mediaLight]: lightQueue };
  }

  onModuleInit() {
    this.registry.register(this);
  }

  /** Called once by the worker process. */
  async schedule() {
    await this.maintenanceQueue.upsertJobScheduler(MEDIA_STUCK_SWEEP_JOB, { every: SWEEP_EVERY_MS }, { name: MEDIA_STUCK_SWEEP_JOB, opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } });
  }

  async process(_job?: Job): Promise<{ requeued: number; failed: number }> {
    const now = this.clock.now().getTime();
    let requeued = 0;
    let failed = 0;
    let after: string | undefined;
    for (;;) {
      const batch = await this.prisma.mediaAsset.findMany({
        where: { status: { in: ["UPLOADED", "PROCESSING"] }, updatedAt: { lt: new Date(now - STUCK_AFTER_LIGHT_MS) }, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: "asc" },
        take: BATCH_SIZE,
      });
      if (batch.length === 0) break;
      after = batch[batch.length - 1].id;
      for (const asset of batch) {
        if (now - asset.updatedAt.getTime() < this.thresholdFor(asset)) continue;
        try {
          const outcome = await this.sweep(asset);
          if (outcome === "requeued") requeued++;
          else if (outcome === "failed") failed++;
        } catch (err) {
          this.logger.error(`stuck-asset sweep of ${asset.id} failed: ${(err as Error).message}`);
        }
      }
    }
    if (requeued || failed) this.logger.warn(`stuck media: ${requeued} re-queued, ${failed} failed`);
    return { requeued, failed };
  }

  private thresholdFor(asset: Pick<MediaAsset, "purpose">): number {
    return MEDIA_RULES[asset.purpose].kind === "video" ? STUCK_AFTER_VIDEO_MS : STUCK_AFTER_LIGHT_MS;
  }

  private async sweep(asset: MediaAsset): Promise<"alive" | "requeued" | "failed"> {
    const target = this.queues[queueNameFor(asset.purpose)]!;
    // Before the lesson queue existed, lesson jobs lived on the reel queue: look there too.
    const legacy = this.queues[QueueNames.mediaTranscode]!;
    let job: Job<MediaJobData> | undefined = await target.getJob(asset.id);
    if (!job && target !== legacy && MEDIA_RULES[asset.purpose].kind === "video") job = await legacy.getJob(asset.id);
    if (job && LIVE_STATES.has(await job.getState())) return "alive";

    const tries = job?.data?.sweep ?? 0;
    // A finished or failed job still holds the jobId; remove it so the next add (or nothing) is clean.
    await job?.remove().catch(() => undefined);
    if (tries >= MAX_SWEEP_REQUEUES) return (await this.lifecycle.markFailed(asset.id, "PROCESSING_ERROR")) ? "failed" : "alive";
    await enqueueMediaJob(target, asset.purpose, asset.id, tries + 1);
    return "requeued";
  }
}
