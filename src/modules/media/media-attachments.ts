import { Inject, Injectable } from "@nestjs/common";
import type { MediaAsset, Prisma } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";

/**
 * Attaching and releasing media, and the small read the attaching modules need first. It needs only the database and the clock, so the worker
 * process (which has no upload machinery) can attach too: MediaService delegates to it. See MediaService.attach for the contract.
 */
@Injectable()
export class MediaAttachments {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Owner, purpose, state and duration of an asset, for modules that decide who may attach it. Not an access check: attach() re-verifies under a row lock. */
  async assetInfo(assetId: string): Promise<{ ownerId: string; orgId: string | null; purpose: MediaAsset["purpose"]; status: MediaAsset["status"]; durationSec: number | null } | null> {
    return this.prisma.mediaAsset.findUnique({ where: { id: assetId }, select: { ownerId: true, orgId: true, purpose: true, status: true, durationSec: true } });
  }

  /** Duration in seconds by asset id (null when unknown), for modules that report on their videos in bulk. */
  async durations(assetIds: string[]): Promise<Map<string, number | null>> {
    if (assetIds.length === 0) return new Map();
    const rows = await this.prisma.mediaAsset.findMany({ where: { id: { in: assetIds } }, select: { id: true, durationSec: true } });
    return new Map(rows.map((r) => [r.id, r.durationSec]));
  }

  async attach(tx: Prisma.TransactionClient, assetId: string, ownerId: string, purpose: MediaAsset["purpose"]): Promise<void> {
    await this.claim(tx, assetId, ownerId, purpose, ["READY"]);
  }

  /**
   * Like attach(), for a consumer that is created while the video is still being processed (a reel): the asset may be UPLOADED, PROCESSING or
   * READY. The attachment protects it from the orphan cleanup for as long as the consumer lives; if processing fails the consumer detaches it.
   */
  async reserve(tx: Prisma.TransactionClient, assetId: string, ownerId: string, purpose: MediaAsset["purpose"]): Promise<void> {
    await this.claim(tx, assetId, ownerId, purpose, ["UPLOADED", "PROCESSING", "READY"]);
  }

  private async claim(tx: Prisma.TransactionClient, assetId: string, ownerId: string, purpose: MediaAsset["purpose"], statuses: MediaAsset["status"][]): Promise<void> {
    // Row lock: concurrent attaches / detaches of one asset serialise, so "exactly one attachment" holds.
    await tx.$queryRaw`SELECT "id" FROM "media_assets" WHERE "id" = ${assetId} FOR UPDATE`;
    const asset = await tx.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.ownerId !== ownerId || asset.purpose !== purpose || !statuses.includes(asset.status)) {
      throw new AppError("MEDIA_NOT_USABLE", 422, "This media cannot be used here: it must be your own, fully processed upload of the right type");
    }
    // An asset belongs to exactly one target. Callers re-saving the same target skip attach/detach when the id is unchanged.
    if (asset.attachedAt) throw new AppError("MEDIA_NOT_USABLE", 409, "This media is already in use somewhere else; upload it again to use it here");
    await tx.mediaAsset.update({ where: { id: assetId }, data: { attachedAt: this.clock.now(), detachedAt: null } });
  }

  async detach(tx: Prisma.TransactionClient, assetId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "media_assets" WHERE "id" = ${assetId} FOR UPDATE`;
    await tx.mediaAsset.updateMany({ where: { id: assetId, attachedAt: { not: null } }, data: { attachedAt: null, detachedAt: this.clock.now() } });
  }
}
