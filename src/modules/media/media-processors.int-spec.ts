import sharp from "sharp";
import { v7 as uuidv7 } from "uuid";
import { createMediaWorkerHarness, type MediaWorkerHarness } from "../../../test/support/media-worker";

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

describe("media processors (image, cleanup, failure mail)", () => {
  let h: MediaWorkerHarness;
  beforeAll(async () => {
    h = await createMediaWorkerHarness();
  });
  afterAll(() => h?.close());

  const reload = (id: string) => h.prisma.mediaAsset.findUniqueOrThrow({ where: { id } });
  const jpeg = (w: number, h2: number) => sharp({ create: { width: w, height: h2, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg().toBuffer();

  describe("ImageProcessor", () => {
    it("avatar: square-cropped webp variants (256 and up to 1024), READY, media.ready emitted", async () => {
      const { row, prefix, bucket } = await h.createAsset({ purpose: "AVATAR", source: await jpeg(1600, 900), mime: "image/jpeg" });
      await h.image.process(h.fakeJob({ assetId: row.id }));

      const done = await reload(row.id);
      expect(done.status).toBe("READY");
      expect(done.renditions).toEqual({ "256": `${prefix}/256.webp`, "1024": `${prefix}/1024.webp` });
      expect([done.width, done.height]).toEqual([1600, 900]);
      const small = await sharp(await streamToBuffer(await h.r2.getObject(bucket, `${prefix}/256.webp`))).metadata();
      const big = await sharp(await streamToBuffer(await h.r2.getObject(bucket, `${prefix}/1024.webp`))).metadata();
      expect([small.format, small.width, small.height]).toEqual(["webp", 256, 256]);
      // 1600x900 source: the square is 900 px, which is as large as the 1024 variant can honestly be (no upscaling)
      expect([big.format, big.width, big.height]).toEqual(["webp", 900, 900]);
      expect(await h.events(row.id, "media.ready")).toHaveLength(1);
    });

    it("banner keeps the aspect ratio and never upscales", async () => {
      const { row, prefix, bucket } = await h.createAsset({ purpose: "BANNER", source: await jpeg(600, 200), mime: "image/jpeg" });
      await h.image.process(h.fakeJob({ assetId: row.id }));
      expect((await reload(row.id)).status).toBe("READY");
      const small = await sharp(await streamToBuffer(await h.r2.getObject(bucket, `${prefix}/256.webp`))).metadata();
      const big = await sharp(await streamToBuffer(await h.r2.getObject(bucket, `${prefix}/1024.webp`))).metadata();
      expect([small.width, small.height]).toEqual([256, 85]);
      expect([big.width, big.height]).toEqual([600, 200]);
    });

    it("an undecodable image fails with INVALID_IMAGE and emits media.failed", async () => {
      const { row } = await h.createAsset({ purpose: "AVATAR", source: Buffer.from("definitely not an image"), mime: "image/png" });
      await h.image.process(h.fakeJob({ assetId: row.id }));
      expect(await reload(row.id)).toMatchObject({ status: "FAILED", failureReason: "INVALID_IMAGE" });
      expect(await h.events(row.id, "media.failed")).toHaveLength(1);
    });
  });

  describe("worker routing", () => {
    it("a media.image job on the media queue is picked up by the registered ImageProcessor", async () => {
      const { row } = await h.createAsset({ purpose: "THUMBNAIL", source: await jpeg(300, 200), mime: "image/jpeg" });
      await h.runner.start();
      await h.mediaQueue.add("media.image", { assetId: row.id }, { jobId: row.id, attempts: 2 });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && (await reload(row.id)).status !== "READY") await new Promise((r) => setTimeout(r, 100));
      expect((await reload(row.id)).status).toBe("READY");
      await h.runner.stop();
    });
  });

  describe("MediaCleanupProcessor", () => {
    it("deletes unattached assets older than 24 h (row + every object under the prefix) and keeps the rest", async () => {
      const old = await h.createAsset({ purpose: "THUMBNAIL", source: await jpeg(50, 50), mime: "image/jpeg", status: "READY", ageHours: 25 });
      await h.r2.putObject(old.bucket, `${old.prefix}/256.webp`, Buffer.from("x"), "image/webp");
      const attached = await h.createAsset({ purpose: "THUMBNAIL", source: await jpeg(50, 50), mime: "image/jpeg", status: "READY", ageHours: 25, attached: true });
      const fresh = await h.createAsset({ purpose: "THUMBNAIL", source: await jpeg(50, 50), mime: "image/jpeg", status: "READY", ageHours: 1 });

      await h.cleanup.process(h.fakeJob({}));

      expect(await h.prisma.mediaAsset.findUnique({ where: { id: old.row.id } })).toBeNull();
      expect(await h.r2.listKeys(old.bucket, old.prefix)).toEqual([]);
      expect(await h.prisma.mediaAsset.findUnique({ where: { id: attached.row.id } })).not.toBeNull();
      expect((await h.r2.listKeys(attached.bucket, attached.prefix)).length).toBeGreaterThan(0);
      expect(await h.prisma.mediaAsset.findUnique({ where: { id: fresh.row.id } })).not.toBeNull();
    });

    it("aborts the multipart upload of a PENDING asset older than 24 h, then deletes it", async () => {
      const uploadId = await h.r2.createMultipart("PUBLIC", `reel/x/y/source`, "video/mp4");
      const { row, bucket } = await h.createAsset({ purpose: "REEL", status: "PENDING", ageHours: 30, uploadId });
      // point the row at the key the upload was created for
      await h.prisma.mediaAsset.update({ where: { id: row.id }, data: { objectKey: "reel/x/y/source" } });

      await h.cleanup.process(h.fakeJob({}));

      expect(await h.prisma.mediaAsset.findUnique({ where: { id: row.id } })).toBeNull();
      // completing an aborted upload fails with NoSuchUpload
      await expect(h.r2.completeMultipart(bucket, "reel/x/y/source", uploadId, [{ partNumber: 1, etag: '"abc"' }])).rejects.toMatchObject({ name: "NoSuchUpload" });
    });

    it("an asset attached while cleanup runs survives (the delete only matches unattached rows)", async () => {
      const { row } = await h.createAsset({ purpose: "THUMBNAIL", source: await jpeg(10, 10), mime: "image/jpeg", status: "READY", ageHours: 40 });
      await h.prisma.mediaAsset.update({ where: { id: row.id }, data: { attachedAt: new Date() } });
      await h.cleanup.process(h.fakeJob({}));
      expect(await h.prisma.mediaAsset.findUnique({ where: { id: row.id } })).not.toBeNull();
    });
  });

  describe("media.failed mail", () => {
    it("queues one media_failed mail to the owner, even when the event is delivered twice", async () => {
      const email = `owner-${uuidv7()}@example.com`;
      const user = await h.prisma.user.create({ data: { email } });
      const assetId = uuidv7();
      await h.prisma.mediaAsset.create({
        data: { id: assetId, ownerId: user.id, purpose: "REEL", bucket: "PUBLIC", status: "FAILED", objectKey: "k", filename: "holiday.mp4", mime: "video/mp4", declaredSize: 1n },
      });
      const event = { type: "media.failed" as const, assetId, ownerId: user.id, reason: "DURATION_EXCEEDED" };
      await h.bus.dispatch(event);
      await h.bus.dispatch(event);

      const jobs = (await h.mailQueue.getJobs(["waiting", "delayed", "active", "completed"])).filter((j) => j.data.to === email);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].data).toMatchObject({ template: "media_failed", data: { fileName: "holiday.mp4", reason: expect.stringMatching(/90 seconds/i) } });
    });
  });
});
