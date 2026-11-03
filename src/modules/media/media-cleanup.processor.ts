import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { SOURCE_BUCKET, assetPrefix, sourcePrefixOf } from "./media.rules";
import { R2Client } from "./r2.client";

export const MEDIA_CLEANUP_JOB = "media.cleanup";
export const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;

/**
 * Hourly: unattached assets older than 24 h are deleted (objects under the asset prefix, then the row), and the
 * multipart upload of an abandoned PENDING asset is aborted first. Every consumer of media calls MediaService.attach,
 * so an asset that is in use always has `attachedAt` and is never touched here.
 */
@Injectable()
export class MediaCleanupProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.maintenance;
  readonly jobNames = [MEDIA_CLEANUP_JOB];
  private readonly logger = new Logger(MediaCleanupProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Client,
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
          if (await this.deleteOne(asset.id)) deleted++;
        } catch (err) {
          failed++;
          this.logger.error(`could not delete orphaned asset ${asset.id}: ${(err as Error).message}`);
        }
      }
    }
    if (deleted || failed) this.logger.log(`orphan cleanup: ${deleted} deleted, ${failed} failed`);
    return { deleted, failed };
  }

  /**
   * The row delete comes first and is conditional on `attachedAt IS NULL`; it holds the row lock while the objects are
   * removed. A concurrent attach() therefore either wins (the delete matches nothing and the objects stay) or finds the
   * row gone. If storage fails the transaction rolls back and the next run retries.
   */
  private async deleteOne(id: string): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        const asset = await tx.mediaAsset.findUnique({ where: { id } });
        if (!asset) return false;
        const removed = await tx.mediaAsset.deleteMany({ where: { id, attachedAt: null } });
        if (removed.count === 0) return false;
        if (asset.status === "PENDING" && asset.uploadId) await this.r2.abortMultipart(SOURCE_BUCKET, asset.objectKey, asset.uploadId);
        await this.r2.deletePrefix(SOURCE_BUCKET, sourcePrefixOf(asset.id));
        await this.r2.deletePrefix(asset.bucket, `${assetPrefix(asset)}/`);
        return true;
      },
      { timeout: 60_000 },
    );
  }
}
