import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Production resolves these from PATH (Dockerfile.worker installs ffmpeg); tests point them at ffmpeg-static / ffprobe-static. */
export const ffmpegPath = () => process.env.FFMPEG_PATH || "ffmpeg";
export const ffprobePath = () => process.env.FFPROBE_PATH || "ffprobe";

export const SEGMENT_SECONDS = 6;
export const PROBE_TIMEOUT_MS = 30_000;
export const TRANSCODE_TIMEOUT_MS = 30 * 60_000;

/** Inputs are untrusted: only plain local files may be opened (no http/tcp/concat/subfile/... from inside a crafted container). */
const INPUT_GUARD = ["-protocol_whitelist", "file"];
const EXEC = { maxBuffer: 16 * 1024 * 1024, killSignal: "SIGKILL" as const };

export type RungName = "240p" | "480p" | "720p" | "1080p";

export interface Rung {
  name: RungName;
  /** Short-side pixel size of the rendition (height for landscape, width for portrait). */
  height: number;
  videoKbps: number;
  audioKbps: number;
}

const LADDER: readonly Rung[] = [
  { name: "240p", height: 240, videoKbps: 400, audioKbps: 96 },
  { name: "480p", height: 480, videoKbps: 1000, audioKbps: 96 },
  { name: "720p", height: 720, videoKbps: 2500, audioKbps: 128 },
  { name: "1080p", height: 1080, videoKbps: 5000, audioKbps: 128 },
];

/** Rungs no taller than the source (never upscale), capped at 1080p, and always at least 240p. */
export function ladderFor(sourceHeight: number): Rung[] {
  const rungs = LADDER.filter((r) => r.height <= sourceHeight);
  return rungs.length > 0 ? [...rungs] : [LADDER[0]];
}

/** The dimension the ladder is computed on: height for landscape/square, width for portrait. */
export const ladderBasis = (d: { width: number; height: number }) => Math.min(d.width, d.height);

export interface ProbeResult {
  /** ffprobe's container name, e.g. "mov,mp4,m4a,3gp,3g2,mj2" or "matroska,webm". */
  formatName: string;
  durationSec: number;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

/** The tool ran past its time limit and was killed. */
export class MediaTimeoutError extends Error {
  constructor(public readonly tool: "ffmpeg" | "ffprobe") {
    super(`${tool} timed out`);
    this.name = "MediaTimeoutError";
  }
}

const timedOut = (err: unknown) => {
  const e = err as { killed?: boolean; signal?: string };
  return e.killed === true && e.signal === "SIGKILL";
};

export class MediaToolError extends Error {
  constructor(
    message: string,
    public readonly tool: "ffmpeg" | "ffprobe",
  ) {
    super(message);
    this.name = "MediaToolError";
  }
}

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

/** `cwd` lets callers probe an HLS playlist by relative name (the HLS demuxer cannot resolve segments next to a Windows absolute path). */
export async function probe(path: string, cwd?: string, opts: { timeoutMs?: number } = {}): Promise<ProbeResult> {
  let stdout: string;
  try {
    ({ stdout } = await run(ffprobePath(), ["-v", "error", ...INPUT_GUARD, "-print_format", "json", "-show_format", "-show_streams", path], {
      ...EXEC,
      cwd,
      timeout: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    }));
  } catch (err) {
    if (timedOut(err)) throw new MediaTimeoutError("ffprobe");
    throw new MediaToolError(`ffprobe failed: ${(err as Error).message.split("\n")[0]}`, "ffprobe");
  }
  const json = JSON.parse(stdout) as { streams?: ProbeStream[]; format?: { duration?: string; format_name?: string } };
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && s.width && s.height);
  const hasAudio = streams.some((s) => s.codec_type === "audio");

  // Phone footage is often stored landscape with a rotation flag; ffmpeg auto-rotates, so report the displayed size.
  const rotation = Math.abs(Number(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0)) % 180;
  const [width, height] = video ? (rotation === 90 ? [video.height!, video.width!] : [video.width!, video.height!]) : [0, 0];
  // The playable length is the video's: audio tracks often run a few ms longer (encoder padding). Take the longest video
  // stream (a header can understate the container), and only fall back to the container when no video stream reports one.
  const videoClaims = streams.filter((s) => s.codec_type === "video").map((s) => Number(s.duration)).filter((n) => Number.isFinite(n));
  const fallback = [json.format?.duration, ...streams.map((s) => s.duration)].map(Number).filter((n) => Number.isFinite(n));
  const claims = videoClaims.length > 0 ? videoClaims : fallback;
  const duration = claims.length > 0 ? Math.max(...claims) : 0;
  return { formatName: json.format?.format_name ?? "", durationSec: duration, width, height, hasVideo: Boolean(video), hasAudio };
}

export interface TranscodedRendition {
  name: RungName;
  width: number;
  height: number;
  videoKbps: number;
  audioKbps: number;
  /** Path relative to the HLS root, e.g. `480p/index.m3u8`. */
  playlist: string;
}

export function buildMasterPlaylist(renditions: Pick<TranscodedRendition, "name" | "width" | "height" | "videoKbps" | "audioKbps">[]): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const r of renditions) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${(r.videoKbps + r.audioKbps) * 1000},RESOLUTION=${r.width}x${r.height}`, `${r.name}/index.m3u8`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * H.264 + AAC HLS (VOD, 6 s segments), one variant per rung under `outDir/<name>/` and a master playlist at
 * `outDir/index.m3u8`. Portrait sources are scaled on their width, so the rung is the short side.
 */
export async function transcodeToHls(
  input: string,
  outDir: string,
  ladder: Rung[],
  opts: { timeoutMs?: number; maxDurationSec?: number } = {},
): Promise<TranscodedRendition[]> {
  const source = await probe(input);
  if (!source.hasVideo) throw new MediaToolError("no video stream", "ffprobe");
  const portrait = source.height > source.width;
  await mkdir(outDir, { recursive: true });

  const out: TranscodedRendition[] = [];
  for (const rung of ladder) {
    const dir = join(outDir, rung.name);
    await mkdir(dir, { recursive: true });
    const args = [
      "-y", "-loglevel", "error", ...INPUT_GUARD, "-i", input,
      // Output cap: whatever the container claimed, a reel's renditions can never run longer than the limit.
      ...(opts.maxDurationSec !== undefined ? ["-t", String(opts.maxDurationSec)] : []),
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", portrait ? `scale=${rung.height}:-2` : `scale=-2:${rung.height}`,
      "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main", "-pix_fmt", "yuv420p",
      "-b:v", `${rung.videoKbps}k`, "-maxrate", `${Math.round(rung.videoKbps * 1.07)}k`, "-bufsize", `${rung.videoKbps * 2}k`,
      // Keyframes on every segment boundary so each 6 s segment starts cleanly.
      "-sc_threshold", "0", "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
      "-c:a", "aac", "-b:a", `${rung.audioKbps}k`, "-ac", "2",
      "-f", "hls", "-hls_time", String(SEGMENT_SECONDS), "-hls_playlist_type", "vod",
      "-hls_segment_filename", "seg%03d.ts", "index.m3u8",
    ];
    try {
      await run(ffmpegPath(), args, { ...EXEC, cwd: dir, timeout: opts.timeoutMs ?? TRANSCODE_TIMEOUT_MS });
    } catch (err) {
      if (timedOut(err)) throw new MediaTimeoutError("ffmpeg");
      throw new MediaToolError(`ffmpeg failed (${rung.name}): ${(err as Error).message.slice(0, 500)}`, "ffmpeg");
    }
    const dims = await probe("index.m3u8", dir);
    out.push({ name: rung.name, width: dims.width, height: dims.height, videoKbps: rung.videoKbps, audioKbps: rung.audioKbps, playlist: `${rung.name}/index.m3u8` });
  }
  await writeFile(join(outDir, "index.m3u8"), buildMasterPlaylist(out));
  return out;
}

/** One JPEG frame, taken at `atSec` (clamped into the clip). */
export async function extractPoster(input: string, output: string, atSec: number, durationSec: number, opts: { timeoutMs?: number } = {}): Promise<void> {
  const at = Math.max(0, Math.min(atSec, durationSec / 2));
  try {
    await run(ffmpegPath(), ["-y", "-loglevel", "error", ...INPUT_GUARD, "-ss", at.toFixed(2), "-i", input, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", output], {
      ...EXEC,
      timeout: opts.timeoutMs ?? PROBE_TIMEOUT_MS * 2,
    });
  } catch (err) {
    if (timedOut(err)) throw new MediaTimeoutError("ffmpeg");
    throw new MediaToolError(`ffmpeg poster failed: ${(err as Error).message.slice(0, 500)}`, "ffmpeg");
  }
}
