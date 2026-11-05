import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { SOURCE_BUCKET, assetPrefix, sourcePrefixOf } from "./media.rules";
import { R2Client } from "./r2.client";

/**
 * Deletes an unattached asset: the row first (conditional on `attachedAt IS NULL`, holding the row lock) and then every object under its prefix.
 * A concurrent attach() either wins (nothing is deleted) or finds the row gone. If storage fails the transaction rolls back and the caller may retry.
 * Used by the hourly orphan cleanup and, via MediaAttachments.takedown, right after a moderator removes content. Needs only the database and storage,
 * so the API and the worker both provide it.
 */
@Injectable()
export class MediaPurger {
  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Client,
  ) {}

  /** True when the asset was deleted; false when it is gone already or in use again. */
  async purge(id: string): Promise<boolean> {
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
