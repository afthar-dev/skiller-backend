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

    it("deletes the source after READY; nothing named source is left in the public bucket", async () => {
      const { row, prefix, bucket, sourceKey } = await h.createAsset({ purpose: "AVATAR", source: await jpeg(300, 300), mime: "image/jpeg" });
      await h.image.process(h.fakeJob({ assetId: row.id }));
      expect(await h.r2.head("PRIVATE", sourceKey)).toBeNull();
      expect(await h.r2.listKeys(bucket, prefix)).toEqual([`${prefix}/1024.webp`, `${prefix}/256.webp`].sort());
      expect((await h.r2.listKeys("PUBLIC", "")).filter((k) => k.endsWith("/source"))).toEqual([]);
    });

    it("an SVG declared as image/jpeg fails with MEDIA_TYPE_MISMATCH", async () => {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
      const { row } = await h.createAsset({ purpose: "AVATAR", source: svg, mime: "image/jpeg" });
      await h.image.process(h.fakeJob({ assetId: row.id }));
      expect(await reload(row.id)).toMatchObject({ status: "FAILED", failureReason: "MEDIA_TYPE_MISMATCH" });
    });

    it("a PNG declared as image/jpeg fails with MEDIA_TYPE_MISMATCH", async () => {
      const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#fff" } }).png().toBuffer();
      const { row } = await h.createAsset({ purpose: "AVATAR", source: png, mime: "image/jpeg" });
      await h.image.process(h.fakeJob({ assetId: row.id }));
      expect(await reload(row.id)).toMatchObject({ status: "FAILED", failureReason: "MEDIA_TYPE_MISMATCH" });
    });

    it("a source overwritten after complete fails with SOURCE_CHANGED", async () => {
      const { row, sourceKey } = await h.createAsset({ purpose: "AVATAR", source: await jpeg(100, 100), mime: "image/jpeg" });
      await h.r2.putObject("PRIVATE", sourceKey, await jpeg(120, 120), "image/jpeg");
      await h.image.process(h.fakeJob({ assetId: row.id }));
      expect(await reload(row.id)).toMatchObject({ status: "FAILED", failureReason: "SOURCE_CHANGED" });
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

  describe("FileProcessor (course resources)", () => {
    it("a real PDF is verified, moved next to the other outputs and READY", async () => {
      const { row, prefix, sourceKey } = await h.createAsset({ purpose: "COURSE_RESOURCE", source: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"), mime: "application/pdf" });
      await h.file.process(h.fakeJob({ assetId: row.id }));
      const done = await reload(row.id);
      expect(done.status).toBe("READY");
      expect(done.objectKey).toBe(`${prefix}/source`);
      expect(await h.r2.head("PRIVATE", `${prefix}/source`)).not.toBeNull();
      expect(await h.r2.head("PRIVATE", sourceKey)).toBeNull();
    });

    it("a zip is accepted by its PK header", async () => {
      const { row } = await h.createAsset({ purpose: "COURSE_RESOURCE", source: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), mime: "application/zip" });
      await h.file.process(h.fakeJob({ assetId: row.id }));
      expect((await reload(row.id)).status).toBe("READY");
    });

    it("a text file declared application/pdf fails with MEDIA_TYPE_MISMATCH", async () => {
      const { row } = await h.createAsset({ purpose: "COURSE_RESOURCE", source: Buffer.from("just some notes"), mime: "application/pdf" });
      await h.file.process(h.fakeJob({ assetId: row.id }));
      expect(await reload(row.id)).toMatchObject({ status: "FAILED", failureReason: "MEDIA_TYPE_MISMATCH" });
    });

    it("a PDF declared as application/zip fails", async () => {
      const { row } = await h.createAsset({ purpose: "COURSE_RESOURCE", source: Buffer.from("%PDF-1.4 x"), mime: "application/zip" });
      await h.file.process(h.fakeJob({ assetId: row.id }));
      expect(await reload(row.id)).toMatchObject({ status: "FAILED", failureReason: "MEDIA_TYPE_MISMATCH" });
    });
  });

  describe("MediaCleanupProcessor", () => {
    it("deletes a detached asset 24 h after it was detached (even though it is much older), keeps a recently detached one", async () => {
      const stale = await h.createAsset({ purpose: "AVATAR", source: await jpeg(20, 20), mime: "image/jpeg", status: "READY", ageHours: 500, detachedHoursAgo: 25 });
      const recent = await h.createAsset({ purpose: "AVATAR", source: await jpeg(20, 20), mime: "image/jpeg", status: "READY", ageHours: 500, detachedHoursAgo: 2 });
      await h.cleanup.process(h.fakeJob({}));
      expect(await h.prisma.mediaAsset.findUnique({ where: { id: stale.row.id } })).toBeNull();
      expect(await h.r2.listKeys("PRIVATE", `incoming/${stale.row.id}/`)).toEqual([]);
      expect(await h.prisma.mediaAsset.findUnique({ where: { id: recent.row.id } })).not.toBeNull();
    });

    it("also removes the incoming source of an abandoned upload", async () => {
      const old = await h.createAsset({ purpose: "AVATAR", source: await jpeg(20, 20), mime: "image/jpeg", status: "PENDING", ageHours: 26 });
      await h.cleanup.process(h.fakeJob({}));
      expect(await h.r2.head("PRIVATE", old.sourceKey)).toBeNull();
    });

    it("deletes unattached assets older than 24 h (row + every object under the prefix) and keeps the rest", async () => {
      const old = await h.createAsset({ purpose: "THUMBNAIL", source: await jpeg(50, 50), mime: "image/jpeg", status: "READY", ageHours: 25 });
      await h.r2.putObject(old.bucket, `${old.prefix}/256.webp`, Buffer.from("x"), "image/webp");
      const attached = await h.createAsset({ purpose: "THUMBNAIL", source: await jpeg(50, 50), mime: "image/jpeg", status: "READY", ageHours: 25, attached: true });
      await h.r2.putObject(attached.bucket, `${attached.prefix}/256.webp`, Buffer.from("x"), "image/webp");
      const fresh = await h.createAsset({ purpose: "THUMBNAIL", source: await jpeg(50, 50), mime: "image/jpeg", status: "READY", ageHours: 1 });

      await h.cleanup.process(h.fakeJob({}));

      expect(await h.prisma.mediaAsset.findUnique({ where: { id: old.row.id } })).toBeNull();
      expect(await h.r2.listKeys(old.bucket, old.prefix)).toEqual([]);
      expect(await h.prisma.mediaAsset.findUnique({ where: { id: attached.row.id } })).not.toBeNull();
      expect((await h.r2.listKeys(attached.bucket, attached.prefix)).length).toBeGreaterThan(0);
      expect(await h.prisma.mediaAsset.findUnique({ where: { id: fresh.row.id } })).not.toBeNull();
    });

    it("aborts the multipart upload of a PENDING asset older than 24 h, then deletes it", async () => {
      const uploadId = await h.r2.createMultipart("PRIVATE", "incoming/x-multi/source", "video/mp4");
      const { row } = await h.createAsset({ purpose: "REEL", status: "PENDING", ageHours: 30, uploadId });
      // point the row at the key the upload was created for
      await h.prisma.mediaAsset.update({ where: { id: row.id }, data: { objectKey: "incoming/x-multi/source" } });

      await h.cleanup.process(h.fakeJob({}));

      expect(await h.prisma.mediaAsset.findUnique({ where: { id: row.id } })).toBeNull();
      // completing an aborted upload fails with NoSuchUpload
      await expect(h.r2.completeMultipart("PRIVATE", "incoming/x-multi/source", uploadId, [{ partNumber: 1, etag: '"abc"' }])).rejects.toMatchObject({ name: "NoSuchUpload" });
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
