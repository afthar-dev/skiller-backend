import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { ensureFixtures } from "../fixtures/make-fixtures";
import { startContainers } from "./containers";

// Runs once per Jest invocation; workers inherit these env vars.
export default async function globalSetup() {
  const containers = await startContainers();
  process.env.DATABASE_URL = containers.databaseUrl;
  process.env.REDIS_URL = containers.redisUrl;
  // Read by applyTestEnv(): points the app's R2 client (and public URLs) at MinIO.
  process.env.MINIO_ENDPOINT = containers.minioEndpoint;
  // No system ffmpeg on dev machines: tests use the static binaries. Production resolves FFMPEG_PATH / PATH.
  process.env.FFMPEG_PATH = ffmpegStatic ?? "ffmpeg";
  process.env.FFPROBE_PATH = ffprobeStatic.path;
  await ensureFixtures();
  (globalThis as { __containers?: typeof containers }).__containers = containers;
}
