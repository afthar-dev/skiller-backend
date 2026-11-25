import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { MediaPurger } from "./media-purger";

export const MEDIA_CLEANUP_JOB = "media.cleanup";
export const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;

/**
 * Hourly: unattached assets older than 24 h are deleted (objects under the asset prefix, then the row), and the
 * multipart upload of an abandoned PENDING asset is aborted first. Assets still UPLOADED or PROCESSING are skipped (see MediaStuckSweeper). Every consumer of media calls MediaService.attach,
 * so an asset that is in use always has `attachedAt` and is never touched here.
 */
@Injectable()
export class MediaCleanupProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.maintenance;
  readonly jobNames = [MEDIA_CLEANUP_JOB];
  private readonly logger = new Logger(MediaCleanupProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly purger: MediaPurger,
    private readonly registry: ProcessorRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  /** Called once by the worker process. */
  async schedule() {
    await this.maintenanceQueue.upsertJobScheduler(
      MEDIA_CLEANUP_JOB,
      { every: 60 * 60 * 1000 },
      { name: MEDIA_CLEANUP_JOB, opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } },
    );
  }

  async process(_job: Job): Promise<{ deleted: number; failed: number }> {
    const cutoff = new Date(this.clock.now().getTime() - ORPHAN_AFTER_MS);
    let deleted = 0;
    let failed = 0;
    let after: string | undefined;
    for (;;) {
      const batch = await this.prisma.mediaAsset.findMany({
        where: {
          attachedAt: null,
          // An upload that is waiting for (or in) processing is not abandoned: the transcode queue can be hours behind, and purging now would delete the row
          // and prefix under the worker. The stuck-asset sweep fails the ones that really are stuck, and then this job removes them.
          status: { notIn: ["UPLOADED", "PROCESSING"] },
          // Never attached: 24 h after creation. Detached (replaced/cleared by its owner): 24 h after detaching.
          OR: [{ detachedAt: null, createdAt: { lt: cutoff } }, { detachedAt: { lt: cutoff } }],
          ...(after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: "asc" },
        take: BATCH_SIZE,
      });
      if (batch.length === 0) break;
      after = batch[batch.length - 1].id;
      for (const asset of batch) {
        try {
          if (await this.purger.purge(asset.id)) deleted++;
        } catch (err) {
          failed++;
          this.logger.error(`could not delete orphaned asset ${asset.id}: ${(err as Error).message}`);
        }
      }
    }
    if (deleted || failed) this.logger.log(`orphan cleanup: ${deleted} deleted, ${failed} failed`);
    return { deleted, failed };
  }
}
