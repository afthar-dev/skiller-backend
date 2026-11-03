import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixturePath } from "../../../test/fixtures/make-fixtures";
import { createMediaWorkerHarness, type MediaWorkerHarness } from "../../../test/support/media-worker";
import { ffmpegPath, ladderFor, probe, transcodeToHls } from "./ffmpeg";

const hasFfmpeg = spawnSync(ffmpegPath(), ["-version"]).status === 0;
if (!hasFfmpeg) {
  console.warn(`ffmpeg not found at "${ffmpegPath()}" (set FFMPEG_PATH): skipping the transcode integration tests`);
}

const mediaTmpDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("skiller-media-"));

(hasFfmpeg ? describe : describe.skip)("TranscodeProcessor", () => {
  let h: MediaWorkerHarness;
  beforeAll(async () => {
    h = await createMediaWorkerHarness();
  });
  afterAll(() => h?.close());

  const run = (assetId: string, attemptsMade = 0) => h.transcode.process(h.fakeJob({ assetId }, attemptsMade));
  const reload = (id: string) => h.prisma.mediaAsset.findUniqueOrThrow({ where: { id } });

  it("transcodes a 3 s 720p reel to READY: master playlist lists 240p/480p/720p, poster exists, media.ready emitted", async () => {
    const before = mediaTmpDirs();
    const { row, prefix, bucket } = await h.createAsset({ purpose: "REEL", source: "sample-3s-720p.mp4", mime: "video/mp4" });

    await run(row.id);

    const done = await reload(row.id);
    expect(done.status).toBe("READY");
    expect(done.durationSec).toBeGreaterThan(2.5);
    expect(done.durationSec).toBeLessThan(3.6);
    expect(done.width).toBe(1280);
    expect(done.height).toBe(720);
    expect(done.posterKey).toBe(`${prefix}/poster.jpg`);
    expect((done.renditions as { name: string }[]).map((r) => r.name)).toEqual(["240p", "480p", "720p"]);

    const keys = await h.r2.listKeys(bucket, prefix);
    expect(keys).toContain(`${prefix}/hls/index.m3u8`);
    expect(keys).toContain(`${prefix}/poster.jpg`);
    for (const name of ["240p", "480p", "720p"]) {
      expect(keys).toContain(`${prefix}/hls/${name}/index.m3u8`);
      expect(keys.some((k) => k.startsWith(`${prefix}/hls/${name}/seg`) && k.endsWith(".ts"))).toBe(true);
    }

    const master = (await streamToString(await h.r2.getObject(bucket, `${prefix}/hls/index.m3u8`))).trim().split("\n");
    expect(master.filter((l) => l.startsWith("#EXT-X-STREAM-INF"))).toHaveLength(3);
    const variant = await streamToString(await h.r2.getObject(bucket, `${prefix}/hls/240p/index.m3u8`));
    expect(variant).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(variant).toContain("#EXT-X-ENDLIST");
    expect(variant).toMatch(/#EXT-X-TARGETDURATION:3/); // one segment: a 3 s clip is shorter than the 6 s target

    expect(await h.events(row.id, "media.ready")).toHaveLength(1);
    expect(mediaTmpDirs()).toEqual(before); // the working directory is always removed
  });

  it("the source is deleted after READY and the public bucket never holds one", async () => {
    const { row, sourceKey } = await h.createAsset({ purpose: "REEL", source: "sample-3s-180p.mp4", mime: "video/mp4" });
    await run(row.id);
    expect(await h.r2.head("PRIVATE", sourceKey)).toBeNull();
    expect((await h.r2.listKeys("PUBLIC", "")).filter((k) => k.endsWith("/source"))).toEqual([]);
  });

  it("a course lesson keeps its private source for reprocessing", async () => {
    const { row, sourceKey } = await h.createAsset({ purpose: "COURSE_LESSON", source: "sample-3s-180p.mp4", mime: "video/mp4" });
    await run(row.id);
    expect((await reload(row.id)).status).toBe("READY");
    expect(await h.r2.head("PRIVATE", sourceKey)).not.toBeNull();
  });

  it("a source overwritten after complete (ETag changed) fails with SOURCE_CHANGED", async () => {
    const { row, sourceKey } = await h.createAsset({ purpose: "REEL", source: "sample-3s-180p.mp4", mime: "video/mp4" });
    await h.r2.putObject("PRIVATE", sourceKey, readFileSync(fixturePath("sample-3s-720p.mp4")), "video/mp4");
    await run(row.id);
    expect(await reload(row.id)).toMatchObject({ status: "FAILED", failureReason: "SOURCE_CHANGED" });
  });

  it("a source whose size differs from the declared size fails with UPLOAD_SIZE_MISMATCH", async () => {
    const { row } = await h.createAsset({ purpose: "REEL", source: "sample-3s-180p.mp4", mime: "video/mp4", declaredSize: 5 });
    await run(row.id);
    expect(await reload(row.id)).toMatchObject({ status: "FAILED", failureReason: "UPLOAD_SIZE_MISMATCH" });
  });

  it("an HLS playlist renamed .mp4 is rejected (container allowlist / protocol whitelist), nothing is fetched", async () => {
    const playlist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/x.ts\n#EXT-X-ENDLIST\n";
    const { row } = await h.createAsset({ purpose: "REEL", source: Buffer.from(playlist), mime: "video/mp4" });
    await run(row.id);
    const done = await reload(row.id);
    expect(done.status).toBe("FAILED");
    expect(done.failureReason).toMatch(/^(MEDIA_TYPE_MISMATCH|INVALID_MEDIA)$/);
  });

  it("a 91 s reel is rejected, a 90 s reel is accepted (no tolerance)", async () => {
    const tooLong = await h.createAsset({ purpose: "REEL", source: "sample-91s-video-only.mp4", mime: "video/mp4" });
    await run(tooLong.row.id);
    expect(await reload(tooLong.row.id)).toMatchObject({ status: "FAILED", failureReason: "DURATION_EXCEEDED" });
    const ok = await h.createAsset({ purpose: "REEL", source: "sample-90s-video-only.mp4", mime: "video/mp4" });
    await run(ok.row.id);
    const done = await reload(ok.row.id);
    expect(done.status).toBe("READY");
    expect(done.durationSec).toBeLessThanOrEqual(90);
  }, 180_000);

  it("transcodeToHls with a duration cap never produces a longer output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skiller-cap-"));
    try {
      await transcodeToHls(fixturePath("sample-3s-180p.mp4"), dir, ladderFor(180), { maxDurationSec: 2 });
      expect((await probe("index.m3u8", join(dir, "240p"))).durationSec).toBeLessThanOrEqual(2.1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a hung ffmpeg is killed and the asset fails with PROCESSING_TIMEOUT", async () => {
    const { row } = await h.createAsset({ purpose: "COURSE_LESSON", source: "sample-portrait-100s.mp4", mime: "video/mp4" });
    const original = h.transcode.transcodeTimeoutMs;
    h.transcode.transcodeTimeoutMs = 1;
    try {
      await run(row.id);
    } finally {
      h.transcode.transcodeTimeoutMs = original;
    }
    expect(await reload(row.id)).toMatchObject({ status: "FAILED", failureReason: "PROCESSING_TIMEOUT" });
  });

  it("a source shorter than 240p gets only the 240p rendition", async () => {
    const { row } = await h.createAsset({ purpose: "REEL", source: "sample-3s-180p.mp4", mime: "video/mp4" });
    await run(row.id);
    const done = await reload(row.id);
    expect(done.status).toBe("READY");
    expect((done.renditions as { name: string }[]).map((r) => r.name)).toEqual(["240p"]);
  });

  it("is idempotent: running a finished asset again changes nothing and emits no second event", async () => {
    const { row } = await h.createAsset({ purpose: "REEL", source: "sample-3s-180p.mp4", mime: "video/mp4" });
    await run(row.id);
    await run(row.id);
    expect(await h.events(row.id, "media.ready")).toHaveLength(1);
  });

  it("rejects a 100 s reel with DURATION_EXCEEDED (nothing is transcoded) and emits media.failed", async () => {
    const before = mediaTmpDirs();
    const { row, prefix, bucket } = await h.createAsset({ purpose: "REEL", source: "sample-portrait-100s.mp4", mime: "video/mp4" });
    await run(row.id);
    const done = await reload(row.id);
    expect(done).toMatchObject({ status: "FAILED", failureReason: "DURATION_EXCEEDED" });
    expect(await h.r2.listKeys(bucket, `${prefix}/hls/`)).toEqual([]);
    const failed = await h.events(row.id, "media.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload).toMatchObject({ reason: "DURATION_EXCEEDED", ownerId: row.ownerId });
    expect(mediaTmpDirs()).toEqual(before);
  });

  it("the same 100 s clip is fine as a course lesson (no duration cap) and ladders on width for portrait", async () => {
    const { row } = await h.createAsset({ purpose: "COURSE_LESSON", source: "sample-portrait-100s.mp4", mime: "video/mp4" });
    await run(row.id);
    const done = await reload(row.id);
    expect(done.status).toBe("READY");
    // 360x640: the short side (360) decides -> 240p only (480 > 360); portrait output is 240 wide
    const [only, ...rest] = done.renditions as { name: string; width: number; height: number }[];
    expect(rest).toEqual([]);
    expect([only.name, only.width]).toEqual(["240p", 240]);
    expect(only.height).toBeGreaterThanOrEqual(426);
    expect(only.height).toBeLessThanOrEqual(428);
    expect(done.bucket).toBe("PRIVATE");
    // 6 s segments: 100 s -> 17 of them, and the playlist's target duration is 6
    const prefix = `course_lesson/${row.ownerId}/${row.id}`;
    const keys = await h.r2.listKeys("PRIVATE", `${prefix}/hls/240p/`);
    expect(keys.filter((k) => k.endsWith(".ts"))).toHaveLength(17);
    expect(await streamToString(await h.r2.getObject("PRIVATE", `${prefix}/hls/240p/index.m3u8`))).toContain("#EXT-X-TARGETDURATION:6");
  }, 180_000);

  it("a file without a video stream fails with NO_VIDEO_STREAM", async () => {
    const { row } = await h.createAsset({ purpose: "REEL", source: "sample-audio-only.mp4", mime: "video/mp4" });
    await run(row.id);
    expect(await reload(row.id)).toMatchObject({ status: "FAILED", failureReason: "NO_VIDEO_STREAM" });
  });

  it("garbage bytes fail with INVALID_MEDIA without retrying", async () => {
    const { row } = await h.createAsset({ purpose: "REEL", source: randomBytes(5000), mime: "video/mp4" });
    await run(row.id);
    expect(await reload(row.id)).toMatchObject({ status: "FAILED", failureReason: "INVALID_MEDIA" });
  });

  it("a transient failure rethrows for BullMQ to retry; only the final attempt marks the asset FAILED", async () => {
    const { row } = await h.createAsset({ purpose: "REEL", mime: "video/mp4" }); // no source object -> download fails
    await expect(run(row.id, 0)).rejects.toThrow();
    expect((await reload(row.id)).status).toBe("PROCESSING");
    await expect(run(row.id, 1)).rejects.toThrow();
    expect(await reload(row.id)).toMatchObject({ status: "FAILED", failureReason: "PROCESSING_ERROR" });
    expect(await h.events(row.id, "media.failed")).toHaveLength(1);
  });
});

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}
