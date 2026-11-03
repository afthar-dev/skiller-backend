import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Job } from "bullmq";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { MediaLifecycle, PermanentMediaFailure } from "./media-lifecycle";
import { FILE_JOB, SOURCE_BUCKET, assetPrefix, sourceKeyOf } from "./media.rules";
import { R2Client } from "./r2.client";
import { isPreconditionFailed, verifySource } from "./source-fetch";

const startsWith = (buf: Buffer, bytes: number[]) => bytes.every((b, i) => buf[i] === b);
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04

/** Course resources (pdf / zip): no transformation, but the bytes must really be what was declared before they become READY. */
@Injectable()
export class FileProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.mediaLight;
  readonly jobNames = [FILE_JOB];
  readonly concurrency = 4;
  private readonly logger = new Logger(FileProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Client,
    private readonly lifecycle: MediaLifecycle,
    private readonly registry: ProcessorRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async process(job: Job<{ assetId: string }>): Promise<void> {
    const { assetId } = job.data;
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || !["UPLOADED", "PROCESSING"].includes(asset.status)) return;
    await this.prisma.mediaAsset.updateMany({ where: { id: assetId, status: "UPLOADED" }, data: { status: "PROCESSING" } });

    try {
      const etag = await verifySource(this.r2, asset);
      let head: Buffer;
      try {
        head = await this.r2.readHead(SOURCE_BUCKET, asset.objectKey, 8, { ifMatch: etag });
      } catch (err) {
        if (isPreconditionFailed(err)) throw new PermanentMediaFailure("SOURCE_CHANGED");
        throw err;
      }
      const isPdf = asset.mime === "application/pdf";
      if (!startsWith(head, isPdf ? PDF_MAGIC : ZIP_MAGIC)) throw new PermanentMediaFailure("MEDIA_TYPE_MISMATCH");

      // Resources live next to the other outputs of the asset (private bucket both times, so this is a server-side copy).
      const finalKey = `${assetPrefix(asset)}/source`;
      await this.r2.copy(SOURCE_BUCKET, asset.objectKey, finalKey);
      const ready = await this.lifecycle.markReady(assetId, { objectKey: finalKey });
      if (ready) await this.r2.delete(SOURCE_BUCKET, sourceKeyOf(assetId));
    } catch (err) {
      this.logger.warn(`asset ${assetId}: ${(err as Error).message}`);
      await this.lifecycle.handleJobError(job, assetId, err);
    }
  }
}
