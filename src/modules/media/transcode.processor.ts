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
import { MediaTimeoutError, MediaToolError, PROBE_TIMEOUT_MS, TRANSCODE_TIMEOUT_MS, extractPoster, ladderBasis, ladderFor, probe, transcodeToHls } from "./ffmpeg";
import { MediaLifecycle, PermanentMediaFailure } from "./media-lifecycle";
import { ALLOWED_VIDEO_FORMATS, MEDIA_RULES, SOURCE_BUCKET, TRANSCODE_JOB, assetPrefix, sourcePrefixOf } from "./media.rules";
import { fetchSource } from "./source-fetch";
import { R2Client } from "./r2.client";

const UPLOAD_CONCURRENCY = 6;
/** A reel may be up to 90 s plus this much measurement slack; the output is hard-capped at 90 s (-t) regardless. */
const DURATION_SLACK_SEC = 0.1;

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
  /** Public so tests can shrink them; a hung ffmpeg is SIGKILLed at the limit. */
  probeTimeoutMs = PROBE_TIMEOUT_MS;
  transcodeTimeoutMs = TRANSCODE_TIMEOUT_MS;

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
    // ffmpeg only ever sees this local copy, never a URL or a key.
    const source = join(dir, "source");
    await fetchSource(this.r2, asset, source);

    let info;
    try {
      info = await probe(source, undefined, { timeoutMs: this.probeTimeoutMs });
    } catch (err) {
      if (err instanceof MediaTimeoutError) throw new PermanentMediaFailure("PROCESSING_TIMEOUT");
      if (err instanceof MediaToolError) throw new PermanentMediaFailure("INVALID_MEDIA");
      throw err;
    }
    if (!ALLOWED_VIDEO_FORMATS.has(info.formatName)) throw new PermanentMediaFailure("MEDIA_TYPE_MISMATCH");
    if (!info.hasVideo) throw new PermanentMediaFailure("NO_VIDEO_STREAM");
    const maxDuration = MEDIA_RULES[asset.purpose].maxDurationSec;
    if (maxDuration !== undefined && info.durationSec > maxDuration + DURATION_SLACK_SEC) throw new PermanentMediaFailure("DURATION_EXCEEDED");

    const hlsDir = join(dir, "hls");
    const posterPath = join(dir, "poster.jpg");
    let renditions;
    try {
      renditions = await transcodeToHls(source, hlsDir, ladderFor(ladderBasis(info)), { timeoutMs: this.transcodeTimeoutMs, maxDurationSec: maxDuration });
      await extractPoster(source, posterPath, 1, info.durationSec);
    } catch (err) {
      if (err instanceof MediaTimeoutError) throw new PermanentMediaFailure("PROCESSING_TIMEOUT");
      throw err;
    }

    const prefix = assetPrefix(asset);
    const files = (await listFiles(hlsDir)).map((path) => ({ path, key: `${prefix}/hls/${relative(hlsDir, path).split(sep).join("/")}` }));
    files.push({ path: posterPath, key: `${prefix}/poster.jpg` });
    await this.uploadAll(asset, files);

    const ready = await this.lifecycle.markReady(asset.id, {
      durationSec: maxDuration !== undefined ? Math.min(info.durationSec, maxDuration) : info.durationSec,
      width: info.width,
      height: info.height,
      posterKey: `${prefix}/poster.jpg`,
      renditions: renditions.map((r) => ({ name: r.name, width: r.width, height: r.height, videoKbps: r.videoKbps, audioKbps: r.audioKbps, playlist: `hls/${r.playlist}` })),
    });
    // The original is only needed for lessons (kept privately for reprocessing); everything else is derived from it.
    if (ready && asset.purpose !== "COURSE_LESSON") await this.r2.deletePrefix(SOURCE_BUCKET, sourcePrefixOf(asset.id));
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
