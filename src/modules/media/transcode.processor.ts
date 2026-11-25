import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { SettingsService } from "../admin";
import type { MediaAsset } from "@prisma/client";
import type { Job } from "bullmq";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { MediaTimeoutError, MediaToolError, PROBE_TIMEOUT_MS, TRANSCODE_MS_PER_SOURCE_SEC, TRANSCODE_TIMEOUT_MS, transcodeTimeoutFor, extractPoster, ladderBasis, ladderFor, probe, transcodeToHls } from "./ffmpeg";
import { MediaLifecycle, PermanentMediaFailure } from "./media-lifecycle";
import { ALLOWED_VIDEO_FORMATS, MEDIA_RULES, SOURCE_BUCKET, TRANSCODE_JOB, assetPrefix, sourcePrefixOf } from "./media.rules";
import { effectiveMaxBytes } from "./media-limits";
import { fetchSource } from "./source-fetch";
import { R2Client } from "./r2.client";

const UPLOAD_CONCURRENCY = 6;
/** A reel may be up to reel_max_seconds plus this much measurement slack; the output is hard-capped at that value (-t) regardless. */
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
  readonly queue = QueueNames.mediaTranscode;
  readonly jobNames = [TRANSCODE_JOB];
  readonly concurrency = 1; // ffmpeg saturates the machine; scale by running more worker processes
  // The worker is redeployed (SIGTERM, then SIGKILL) while a long transcode may be running; each kill stalls the job once. Three stalls are a real crash loop.
  readonly maxStalledCount = 3;
  private readonly logger = new Logger(TranscodeProcessor.name);
  /** Public so tests can shrink them; a hung ffmpeg is SIGKILLed at the limit. */
  probeTimeoutMs = PROBE_TIMEOUT_MS;
  transcodeTimeoutMs = TRANSCODE_TIMEOUT_MS;
  /** The limit per rendition is max(transcodeTimeoutMs, source duration * this), so a long lesson is not killed for being long. */
  transcodeMsPerSourceSec = TRANSCODE_MS_PER_SOURCE_SEC;

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Client,
    private readonly lifecycle: MediaLifecycle,
    private readonly registry: ProcessorRegistry,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit() {
    this.registry.register(this);
    // Course lessons run on their own queue (so a reel never waits behind one) with this same code. Jobs queued on the reel queue before that split are still served above.
    this.registry.register({
      queue: QueueNames.mediaTranscodeLong,
      jobNames: this.jobNames,
      concurrency: this.concurrency,
      maxStalledCount: this.maxStalledCount,
      process: (job) => this.process(job),
      onExhausted: (job, err) => this.onExhausted(job, err),
    });
  }

  /** Every attempt failed, or the job stalled out (worker killed or OOM) without the catch in process() running: the asset must not stay PROCESSING. */
  async onExhausted(job: Job<{ assetId: string }>, _err: Error): Promise<void> {
    const { assetId } = job.data;
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset) return;
    if (await this.lifecycle.markFailed(assetId, "PROCESSING_ERROR")) await this.r2.deletePrefix(asset.bucket, `${assetPrefix(asset)}/hls/`).catch(() => undefined);
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
    await fetchSource(this.r2, asset, source, await effectiveMaxBytes(this.settings, asset.purpose));

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
    // Reels are capped by the reel_max_seconds platform setting; other purposes keep their static rule (none today).
    const maxDuration = asset.purpose === "REEL" ? await this.settings.get("reel_max_seconds") : MEDIA_RULES[asset.purpose].maxDurationSec;
    if (maxDuration !== undefined && info.durationSec > maxDuration + DURATION_SLACK_SEC) throw new PermanentMediaFailure("DURATION_EXCEEDED");

    const hlsDir = join(dir, "hls");
    const posterPath = join(dir, "poster.jpg");
    let renditions;
    try {
      renditions = await transcodeToHls(source, hlsDir, ladderFor(ladderBasis(info)), { timeoutMs: transcodeTimeoutFor(info.durationSec, this.transcodeTimeoutMs, this.transcodeMsPerSourceSec), maxDurationSec: maxDuration });
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
