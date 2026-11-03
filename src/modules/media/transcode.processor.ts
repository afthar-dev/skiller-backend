import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { MediaAsset } from "@prisma/client";
import type { Job } from "bullmq";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { MediaToolError, extractPoster, ladderBasis, ladderFor, probe, transcodeToHls } from "./ffmpeg";
import { MediaLifecycle, PermanentMediaFailure } from "./media-lifecycle";
import { MEDIA_RULES, TRANSCODE_JOB, assetPrefix } from "./media.rules";
import { R2Client } from "./r2.client";

/** Container durations run a few hundredths over the nominal length (encoder padding): don't reject a 90.02 s "90 s" reel. */
const DURATION_TOLERANCE_SEC = 0.5;
const UPLOAD_CONCURRENCY = 6;

const CONTENT_TYPES: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".jpg": "image/jpeg",
};
const contentTypeOf = (file: string) => CONTENT_TYPES[file.slice(file.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else out.push(path);
  }
  return out;
}

@Injectable()
export class TranscodeProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.media;
  readonly jobNames = [TRANSCODE_JOB];
  readonly concurrency = 1; // ffmpeg saturates the machine; scale by running more worker processes
  private readonly logger = new Logger(TranscodeProcessor.name);

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
    // Finished (retry after a late crash), failed, or never completed: nothing to do.
    if (!asset || !["UPLOADED", "PROCESSING"].includes(asset.status)) return;
    await this.prisma.mediaAsset.updateMany({ where: { id: assetId, status: "UPLOADED" }, data: { status: "PROCESSING" } });

    const dir = await mkdtemp(join(tmpdir(), "skiller-media-"));
    try {
      await this.transcode(asset, dir);
    } catch (err) {
      this.logger.warn(`asset ${assetId}: ${(err as Error).message}`);
      await this.lifecycle.handleJobError(job, assetId, err).catch(async (rethrown) => {
        // Final attempt or about to retry: leave no half-uploaded rendition behind.
        await this.r2.deletePrefix(asset.bucket, `${assetPrefix(asset)}/hls/`).catch(() => undefined);
        throw rethrown;
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async transcode(asset: MediaAsset, dir: string): Promise<void> {
    const source = join(dir, "source");
    await this.r2.downloadTo(asset.bucket, asset.objectKey, source);

    let info;
    try {
      info = await probe(source);
    } catch (err) {
      if (err instanceof MediaToolError) throw new PermanentMediaFailure("INVALID_MEDIA");
      throw err;
    }
    if (!info.hasVideo) throw new PermanentMediaFailure("NO_VIDEO_STREAM");
    const maxDuration = MEDIA_RULES[asset.purpose].maxDurationSec;
    if (maxDuration !== undefined && info.durationSec > maxDuration + DURATION_TOLERANCE_SEC) throw new PermanentMediaFailure("DURATION_EXCEEDED");

    const hlsDir = join(dir, "hls");
    const renditions = await transcodeToHls(source, hlsDir, ladderFor(ladderBasis(info)));
    const posterPath = join(dir, "poster.jpg");
    await extractPoster(source, posterPath, 1, info.durationSec);

    const prefix = assetPrefix(asset);
    const files = (await listFiles(hlsDir)).map((path) => ({ path, key: `${prefix}/hls/${relative(hlsDir, path).split(sep).join("/")}` }));
    files.push({ path: posterPath, key: `${prefix}/poster.jpg` });
    await this.uploadAll(asset, files);

    await this.lifecycle.markReady(asset.id, {
      durationSec: info.durationSec,
      width: info.width,
      height: info.height,
      posterKey: `${prefix}/poster.jpg`,
      renditions: renditions.map((r) => ({ name: r.name, width: r.width, height: r.height, videoKbps: r.videoKbps, audioKbps: r.audioKbps, playlist: `hls/${r.playlist}` })),
    });
  }

  private async uploadAll(asset: MediaAsset, files: { path: string; key: string }[]): Promise<void> {
    const queue = [...files];
    const worker = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        if ((await stat(file.path)).size === 0) continue;
        await this.r2.putObject(asset.bucket, file.key, await readFile(file.path), contentTypeOf(file.path));
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker));
  }
}
