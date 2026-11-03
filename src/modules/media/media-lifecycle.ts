import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { Job } from "bullmq";
import { OutboxService } from "../../common/outbox/outbox.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { toApiPurpose } from "./media.rules";

/** A failure retrying cannot fix (corrupt file, too long, ...): the asset is marked FAILED right away with this reason. */
export class PermanentMediaFailure extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "PermanentMediaFailure";
  }
}

export interface ReadyData {
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
  renditions?: Prisma.InputJsonValue;
  posterKey?: string | null;
  objectKey?: string;
}

/**
 * The only place that moves an asset to READY or FAILED. Both transitions are conditional updates, so they are
 * idempotent under retries and concurrent workers, and the outbox event is written in the same transaction as the
 * transition (only the call that actually flips the status emits it).
 */
@Injectable()
export class MediaLifecycle {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /** UPLOADED | PROCESSING -> READY. Returns false when the asset was already finished (or failed). */
  async markReady(assetId: string, data: ReadyData = {}): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const flipped = await tx.mediaAsset.updateMany({
        where: { id: assetId, status: { in: ["UPLOADED", "PROCESSING"] } },
        data: { status: "READY", failureReason: null, ...data },
      });
      if (flipped.count === 0) return false;
      const asset = await tx.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
      await this.outbox.enqueue(tx, { type: "media.ready", assetId, ownerId: asset.ownerId, purpose: toApiPurpose(asset.purpose) });
      return true;
    });
  }

  /** Any non-final status -> FAILED. Returns false when the asset was already READY or FAILED. */
  async markFailed(assetId: string, reason: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const flipped = await tx.mediaAsset.updateMany({
        where: { id: assetId, status: { in: ["PENDING", "UPLOADED", "PROCESSING"] } },
        data: { status: "FAILED", failureReason: reason },
      });
      if (flipped.count === 0) return false;
      const asset = await tx.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
      await this.outbox.enqueue(tx, { type: "media.failed", assetId, ownerId: asset.ownerId, reason });
      return true;
    });
  }

  /**
   * Common error path of the processors. Permanent failures finish the asset immediately and swallow the error (no retry);
   * anything else is rethrown so BullMQ retries, and only the final attempt marks the asset FAILED.
   */
  async handleJobError(job: Pick<Job, "attemptsMade" | "opts">, assetId: string, err: unknown): Promise<void> {
    if (err instanceof PermanentMediaFailure) {
      await this.markFailed(assetId, err.reason);
      return;
    }
    if (job.attemptsMade + 1 >= (job.opts?.attempts ?? 1)) await this.markFailed(assetId, "PROCESSING_ERROR");
    throw err;
  }
}
