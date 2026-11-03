import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";

/**
 * Generates the (gitignored) video fixtures with ffmpeg's lavfi sources, so no binaries are committed.
 * Runs from Jest's global setup when a file is missing; also runnable by hand: `npx ts-node test/fixtures/make-fixtures.ts`.
 */
const ffmpeg = () => process.env.FFMPEG_PATH ?? ffmpegStatic ?? "ffmpeg";

interface Fixture {
  file: string;
  /** ffmpeg input args (before the encoder args). */
  input: string[];
}

const video = (size: string, rate: number, seconds: number) => [
  "-f", "lavfi", "-i", `testsrc=size=${size}:rate=${rate}:duration=${seconds}`,
  "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
];

export const FIXTURES: Fixture[] = [
  { file: "sample-3s-720p.mp4", input: video("1280x720", 25, 3) },
  { file: "sample-3s-180p.mp4", input: video("320x180", 25, 3) },
  { file: "sample-portrait-100s.mp4", input: video("360x640", 10, 100) },
  { file: "sample-audio-only.mp4", input: ["-f", "lavfi", "-i", "sine=frequency=440:duration=3"] },
];

export const fixturePath = (file: string) => join(__dirname, file);

export async function ensureFixtures(): Promise<void> {
  for (const f of FIXTURES) {
    const out = fixturePath(f.file);
    if (existsSync(out)) continue;
    const isAudioOnly = f.file.includes("audio-only");
    const encode = isAudioOnly
      ? ["-c:a", "aac"]
      : ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"];
    execFileSync(ffmpeg(), ["-y", "-loglevel", "error", ...f.input, ...encode, out], { stdio: "inherit" });
  }
}

if (require.main === module) {
  void ensureFixtures();
}
