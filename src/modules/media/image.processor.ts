import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Job } from "bullmq";
import sharp from "sharp";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { MediaLifecycle, PermanentMediaFailure } from "./media-lifecycle";
import { IMAGE_JOB, assetPrefix } from "./media.rules";
import { R2Client } from "./r2.client";

export const IMAGE_SIZES = [256, 1024] as const;
const WEBP_QUALITY = 82;

async function toBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

@Injectable()
export class ImageProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.media;
  readonly jobNames = [IMAGE_JOB];
  readonly concurrency = 4;
  private readonly logger = new Logger(ImageProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Client,
    private readonly lifecycle: MediaLifecycle,
    private readonly registry: ProcessorRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  /** Source -> webp at 256 and 1024 px wide (never upscaled). Avatars are cropped to a centred square. */
  async process(job: Job<{ assetId: string }>): Promise<void> {
    const { assetId } = job.data;
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || !["UPLOADED", "PROCESSING"].includes(asset.status)) return;
    await this.prisma.mediaAsset.updateMany({ where: { id: assetId, status: "UPLOADED" }, data: { status: "PROCESSING" } });

    try {
      const source = await toBuffer(await this.r2.getObject(asset.bucket, asset.objectKey));
      let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
      try {
        meta = await sharp(source).metadata();
      } catch {
        throw new PermanentMediaFailure("INVALID_IMAGE");
      }
      // EXIF orientations 5-8 swap the displayed width and height.
      const swapped = (meta.orientation ?? 1) >= 5;
      const width = (swapped ? meta.height : meta.width) ?? 0;
      const height = (swapped ? meta.width : meta.height) ?? 0;
      if (!width || !height) throw new PermanentMediaFailure("INVALID_IMAGE");

      const prefix = assetPrefix(asset);
      const renditions: Record<string, string> = {};
      for (const size of IMAGE_SIZES) {
        let pipeline = sharp(source).rotate();
        if (asset.purpose === "AVATAR") {
          const side = Math.min(size, width, height);
          pipeline = pipeline.resize(side, side, { fit: "cover", position: "centre" });
        } else {
          pipeline = pipeline.resize({ width: Math.min(size, width), withoutEnlargement: true });
        }
        let out: Buffer;
        try {
          out = await pipeline.webp({ quality: WEBP_QUALITY }).toBuffer();
        } catch {
          throw new PermanentMediaFailure("INVALID_IMAGE");
        }
        const key = `${prefix}/${size}.webp`;
        await this.r2.putObject(asset.bucket, key, out, "image/webp");
        renditions[String(size)] = key;
      }
      await this.lifecycle.markReady(assetId, { width, height, renditions });
    } catch (err) {
      this.logger.warn(`asset ${assetId}: ${(err as Error).message}`);
      await this.lifecycle.handleJobError(job, assetId, err);
    }
  }
}
