import { randomBytes } from "node:crypto";
import type { Queue } from "bullmq";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { R2Client } from "../../src/modules/media/r2.client";
import { QueueNames, queueToken } from "../../src/common/queue/queue.constants";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const MB = 1024 * 1024;

describe("media upload sessions (MinIO standing in for R2)", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let queue: Queue;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  const create = (s: Session, body: object) => http().post("/v1/media/uploads").set(auth(s)).send(body);
  const complete = (s: Session, id: string, parts?: { partNumber: number; etag: string }[]) =>
    http().post(`/v1/media/uploads/${id}/complete`).set(auth(s)).send(parts ? { parts } : {});
  const get = (s: Session, id: string) => http().get(`/v1/media/${id}`).set(auth(s));

  async function putRaw(url: string, body: Buffer, headers: Record<string, string> = {}) {
    return fetch(url, { method: "PUT", body, headers });
  }
  async function put(url: string, body: Buffer, headers: Record<string, string> = {}): Promise<string> {
    const res = await putRaw(url, body, headers);
    if (res.status !== 200) throw new Error(`PUT ${res.status}: ${await res.text()}`);
    return res.headers.get("etag")!;
  }

  /** Creates the session and PUTs the bytes to the presigned URLs. Returns what `complete` needs. */
  async function upload(s: Session, purpose: string, mime: string, bytes: Buffer, declared = bytes.length) {
    const res = await create(s, { purpose, filename: "f.bin", mime, size: declared });
    expect(res.status).toBe(201);
    const { assetId, partSize, partUrls, putHeaders } = res.body as { assetId: string; partSize: number; partUrls: string[]; putHeaders?: Record<string, string> };
    const parts: { partNumber: number; etag: string }[] = [];
    for (let i = 0; i < partUrls.length; i++) {
      const etag = await put(partUrls[i], bytes.subarray(i * partSize, (i + 1) * partSize), putHeaders);
      parts.push({ partNumber: i + 1, etag });
    }
    return { assetId, partUrls, parts };
  }

  async function creator(): Promise<Session> {
    const s = await t.login();
    const res = await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true });
    expect(res.status).toBe(200);
    return s;
  }

  const png = () => randomBytes(1000);
  const jobsFor = async (assetId: string) => (await queue.getJobs(["waiting", "active", "delayed", "completed", "failed"])).filter((j) => j.id === assetId);

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    queue = t.app.get<Queue>(queueToken(QueueNames.media));
  });
  afterAll(() => t?.close());

  describe("create", () => {
    it("requires authentication", async () => {
      expect((await http().post("/v1/media/uploads").send({})).status).toBe(401);
    });

    it("images get one presigned PUT and no multipart upload id; the source key is incoming/{asset}/source", async () => {
      const s = await t.login();
      const res = await create(s, { purpose: "avatar", filename: "me.png", mime: "image/png", size: 1000 });
      expect(res.status).toBe(201);
      expect(res.body.partUrls).toHaveLength(1);
      expect(res.body.partSize).toBe(10 * MB);
      const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: res.body.assetId } });
      expect(row).toMatchObject({ ownerId: s.userId, purpose: "AVATAR", bucket: "PUBLIC", status: "PENDING", uploadId: null });
      // every source lands in the private bucket under incoming/, whatever the purpose
      expect(row.objectKey).toBe(`incoming/${row.id}/source`);
      expect(res.body.putHeaders).toEqual({ "Content-Type": "image/png" });
    });

    it("videos use multipart: one URL per 10 MB part", async () => {
      const s = await creator();
      const res = await create(s, { purpose: "reel", filename: "r.mp4", mime: "video/mp4", size: 10 * MB + 1 });
      expect(res.status).toBe(201);
      expect(res.body.partUrls).toHaveLength(2);
      const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: res.body.assetId } });
      expect(row.uploadId).toBeTruthy();
      expect(row).toMatchObject({ bucket: "PUBLIC", purpose: "REEL" });
    });

    it("rejects an 11 MB avatar (MEDIA_TOO_LARGE) and a gif reel (MEDIA_TYPE_NOT_ALLOWED)", async () => {
      const s = await creator();
      const big = await create(s, { purpose: "avatar", filename: "a.png", mime: "image/png", size: 11 * MB });
      expect(big.status).toBe(413);
      expect(big.body.error.code).toBe("MEDIA_TOO_LARGE");
      const gif = await create(s, { purpose: "reel", filename: "a.gif", mime: "image/gif", size: MB });
      expect(gif.status).toBe(415);
      expect(gif.body.error.code).toBe("MEDIA_TYPE_NOT_ALLOWED");
    });

    it("reel / course purposes need a creator; avatars do not", async () => {
      const s = await t.login();
      for (const [purpose, mime] of [
        ["reel", "video/mp4"],
        ["course_lesson", "video/mp4"],
        ["course_resource", "application/pdf"],
      ]) {
        const res = await create(s, { purpose, filename: "x", mime, size: MB });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("CREATOR_REQUIRED");
      }
      expect((await create(s, { purpose: "avatar", filename: "x.png", mime: "image/png", size: 1000 })).status).toBe(201);
    });

    it("course lessons and resources land in the private bucket", async () => {
      const s = await creator();
      const lesson = await create(s, { purpose: "course_lesson", filename: "l.mp4", mime: "video/mp4", size: MB });
      const resource = await create(s, { purpose: "course_resource", filename: "r.pdf", mime: "application/pdf", size: MB });
      expect(lesson.status).toBe(201);
      expect(resource.status).toBe(201);
      const rows = await prisma.mediaAsset.findMany({ where: { id: { in: [lesson.body.assetId, resource.body.assetId] } } });
      expect(rows.map((r) => r.bucket)).toEqual(["PRIVATE", "PRIVATE"]);
    });

    it("validates the body", async () => {
      const s = await t.login();
      expect((await create(s, { purpose: "nope", filename: "x", mime: "image/png", size: 5 })).status).toBe(400);
      expect((await create(s, { purpose: "avatar", filename: "x", mime: "image/png", size: 0 })).status).toBe(400);
    });
  });

  describe("complete", () => {
    it("image: complete -> PROCESSING with one media.image job", async () => {
      const s = await t.login();
      const { assetId, parts } = await upload(s, "avatar", "image/png", png());
      const res = await complete(s, assetId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: assetId, status: "PROCESSING", purpose: "avatar" });
      const jobs = await jobsFor(assetId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe("media.image");
      expect(parts).toHaveLength(1);
    });

    it("video: multipart complete -> PROCESSING with exactly one media.transcode job; completing again is idempotent", async () => {
      const s = await creator();
      const bytes = randomBytes(10 * MB + 1000);
      const { assetId, parts } = await upload(s, "reel", "video/mp4", bytes);
      expect(parts).toHaveLength(2);

      const first = await complete(s, assetId, parts);
      expect(first.status).toBe(200);
      expect(first.body.status).toBe("PROCESSING");
      const second = await complete(s, assetId, parts);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);

      const jobs = await jobsFor(assetId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe("media.transcode");
    });

    it("two parallel completes produce one job and the same asset", async () => {
      const s = await creator();
      const { assetId, parts } = await upload(s, "reel", "video/mp4", randomBytes(2 * MB));
      const results = await Promise.all([complete(s, assetId, parts), complete(s, assetId, parts), complete(s, assetId, parts)]);
      for (const r of results) {
        expect(r.status).toBe(200);
        expect(r.body.id).toBe(assetId);
      }
      expect(await jobsFor(assetId)).toHaveLength(1);
    });

    it("size differing from the declared size -> UPLOAD_SIZE_MISMATCH and the asset is FAILED", async () => {
      const s = await t.login();
      const { assetId } = await upload(s, "avatar", "image/png", randomBytes(1000));
      await prisma.mediaAsset.update({ where: { id: assetId }, data: { declaredSize: 1001n } });
      const res = await complete(s, assetId);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("UPLOAD_SIZE_MISMATCH");
      const status = await get(s, assetId);
      expect(status.body).toMatchObject({ status: "FAILED", failureReason: "UPLOAD_SIZE_MISMATCH" });
      expect(await jobsFor(assetId)).toHaveLength(0);
    });

    it("records the source ETag at complete", async () => {
      const s = await t.login();
      const { assetId } = await upload(s, "avatar", "image/png", png());
      await complete(s, assetId);
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).sourceEtag).toBeTruthy();
    });

    it("completing before uploading anything is a retryable 409, not a failure", async () => {
      const s = await t.login();
      const res = await create(s, { purpose: "avatar", filename: "x.png", mime: "image/png", size: 1000 });
      const early = await complete(s, res.body.assetId);
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe("UPLOAD_INCOMPLETE");
      expect((await get(s, res.body.assetId)).body.status).toBe("PENDING");
    });

    it("only the owner can complete", async () => {
      const a = await t.login();
      const b = await t.login();
      const { assetId } = await upload(a, "avatar", "image/png", png());
      expect((await complete(b, assetId)).status).toBe(404);
    });
  });

  describe("presigned scope", () => {
    it("a single PUT with more or fewer bytes than declared is rejected by storage (Content-Length is signed)", async () => {
      const s = await t.login();
      const res = await create(s, { purpose: "avatar", filename: "a.png", mime: "image/png", size: 1000 });
      const over = await putRaw(res.body.partUrls[0], randomBytes(2000), res.body.putHeaders);
      expect(over.status).toBeGreaterThanOrEqual(400);
      const under = await putRaw(res.body.partUrls[0], randomBytes(999), res.body.putHeaders);
      expect(under.status).toBeGreaterThanOrEqual(400);
    });

    it("a different Content-Type is rejected (Content-Type is signed)", async () => {
      const s = await t.login();
      const res = await create(s, { purpose: "avatar", filename: "a.png", mime: "image/png", size: 1000 });
      const bad = await putRaw(res.body.partUrls[0], randomBytes(1000), { "Content-Type": "text/html" });
      expect(bad.status).toBeGreaterThanOrEqual(400);
    });

    it("a multipart part larger than its signed length is rejected", async () => {
      const s = await creator();
      const res = await create(s, { purpose: "reel", filename: "r.mp4", mime: "video/mp4", size: 2 * MB });
      const bad = await putRaw(res.body.partUrls[0], randomBytes(3 * MB));
      expect(bad.status).toBeGreaterThanOrEqual(400);
    });

    it("the public bucket never holds a source object; sources wait in the private bucket", async () => {
      const s = await creator();
      const { assetId } = await upload(s, "avatar", "image/png", png());
      await complete(s, assetId);
      const r2 = t.app.get(R2Client);
      expect((await r2.listKeys("PUBLIC", "")).filter((k) => k.endsWith("/source"))).toEqual([]);
      expect(await r2.listKeys("PRIVATE", `incoming/${assetId}/`)).toEqual([`incoming/${assetId}/source`]);
    });
  });

  describe("abuse caps", () => {
    it("max 10 PENDING assets per user -> 429 UPLOAD_LIMIT_REACHED", async () => {
      const s = await t.login();
      for (let i = 0; i < 10; i++) expect((await create(s, { purpose: "avatar", filename: "a.png", mime: "image/png", size: 100 })).status).toBe(201);
      const res = await create(s, { purpose: "avatar", filename: "a.png", mime: "image/png", size: 100 });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("UPLOAD_LIMIT_REACHED");
    });

    it("30 sessions per hour per user -> 429 UPLOAD_LIMIT_REACHED with Retry-After", async () => {
      const s = await t.login();
      for (let i = 0; i < 30; i++) {
        const r = await create(s, { purpose: "avatar", filename: "a.png", mime: "image/png", size: 100 });
        expect(r.status).toBe(201);
        await prisma.mediaAsset.update({ where: { id: r.body.assetId }, data: { status: "FAILED" } }); // stay under the pending cap
      }
      const res = await create(s, { purpose: "avatar", filename: "a.png", mime: "image/png", size: 100 });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("UPLOAD_LIMIT_REACHED");
      expect(res.body.error.details.retryAfterSec).toBeGreaterThan(0);
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    });
  });

  describe("GET /v1/media/:id", () => {
    it("owner sees status and public urls once READY; others get 404", async () => {
      const a = await t.login();
      const b = await t.login();
      const { assetId } = await upload(a, "avatar", "image/png", png());
      await complete(a, assetId);
      await prisma.mediaAsset.update({
        where: { id: assetId },
        data: { status: "READY", renditions: { "256": `avatar/${a.userId}/${assetId}/256.webp`, "1024": `avatar/${a.userId}/${assetId}/1024.webp` } },
      });
      const res = await get(a, assetId);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("READY");
      expect(res.body.urls["256"]).toMatch(new RegExp(`/avatar/${a.userId}/${assetId}/256\\.webp$`));
      expect((await get(b, assetId)).status).toBe(404);
    });
  });

  describe("attach (profile avatar / banner, org logo)", () => {
    async function readyAsset(s: Session, purpose: "AVATAR" | "BANNER") {
      const asset = await prisma.mediaAsset.create({
        data: { ownerId: s.userId, purpose, bucket: "PUBLIC", status: "READY", objectKey: `${purpose.toLowerCase()}/${s.userId}/x/source`, mime: "image/png", declaredSize: 1n },
      });
      return asset.id;
    }

    it("setting avatar and banner to own READY assets attaches them in the profile update", async () => {
      const s = await t.login();
      const avatar = await readyAsset(s, "AVATAR");
      const banner = await readyAsset(s, "BANNER");
      const res = await http().patch("/v1/me/profile").set(auth(s)).send({ avatarAssetId: avatar, bannerAssetId: banner });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ avatarAssetId: avatar, bannerAssetId: banner });
      const rows = await prisma.mediaAsset.findMany({ where: { id: { in: [avatar, banner] } } });
      expect(rows.every((r) => r.attachedAt !== null)).toBe(true);
    });

    it("another user's READY asset -> MEDIA_NOT_USABLE and the profile is untouched", async () => {
      const a = await t.login();
      const b = await t.login();
      const theirs = await readyAsset(a, "AVATAR");
      const res = await http().patch("/v1/me/profile").set(auth(b)).send({ avatarAssetId: theirs, displayName: "Changed Name" });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("MEDIA_NOT_USABLE");
      const me = await http().get("/v1/me").set(auth(b));
      expect(me.body.profile.avatarAssetId).toBeNull();
      expect(me.body.profile.displayName).not.toBe("Changed Name");
    });

    it("wrong purpose, not READY and unknown assets are not usable", async () => {
      const s = await t.login();
      const banner = await readyAsset(s, "BANNER");
      const pending = await prisma.mediaAsset.create({
        data: { ownerId: s.userId, purpose: "AVATAR", bucket: "PUBLIC", status: "PROCESSING", objectKey: "k", mime: "image/png", declaredSize: 1n },
      });
      const patch = (body: object) => http().patch("/v1/me/profile").set(auth(s)).send(body);
      expect((await patch({ avatarAssetId: banner })).body.error.code).toBe("MEDIA_NOT_USABLE");
      expect((await patch({ avatarAssetId: pending.id })).body.error.code).toBe("MEDIA_NOT_USABLE");
      expect((await patch({ avatarAssetId: "00000000-0000-7000-8000-000000000000" })).body.error.code).toBe("MEDIA_NOT_USABLE");
      expect((await patch({ avatarAssetId: "not-a-uuid" })).status).toBe(400);
    });

    it("replacing or clearing an avatar detaches the old asset", async () => {
      const s = await t.login();
      const first = await readyAsset(s, "AVATAR");
      const second = await readyAsset(s, "AVATAR");
      const patch = (body: object) => http().patch("/v1/me/profile").set(auth(s)).send(body);
      await patch({ avatarAssetId: first });
      await patch({ avatarAssetId: first }); // re-saving the same asset keeps it attached
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: first } })).attachedAt).not.toBeNull();
      await patch({ avatarAssetId: second });
      const old = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: first } });
      expect(old.attachedAt).toBeNull();
      expect(old.detachedAt).not.toBeNull();
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: second } })).attachedAt).not.toBeNull();
      await patch({ avatarAssetId: null });
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: second } })).detachedAt).not.toBeNull();
    });

    it("replacing an org logo detaches the old one", async () => {
      const owner = await t.login();
      const org = await http().post("/v1/orgs").set(auth(owner)).send({ name: "Swap Org", slug: `swap-${Math.random().toString(36).slice(2, 10)}` });
      const a = await readyAsset(owner, "AVATAR");
      const b = await readyAsset(owner, "AVATAR");
      await http().patch(`/v1/orgs/${org.body.slug}`).set(auth(owner)).send({ logoAssetId: a });
      await http().patch(`/v1/orgs/${org.body.slug}`).set(auth(owner)).send({ logoAssetId: b });
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: a } })).detachedAt).not.toBeNull();
    });

    it("avatarAssetId: null clears the avatar", async () => {
      const s = await t.login();
      const avatar = await readyAsset(s, "AVATAR");
      await http().patch("/v1/me/profile").set(auth(s)).send({ avatarAssetId: avatar });
      const res = await http().patch("/v1/me/profile").set(auth(s)).send({ avatarAssetId: null });
      expect(res.status).toBe(200);
      expect(res.body.avatarAssetId).toBeNull();
    });

    it("org logo goes through attach too", async () => {
      const owner = await t.login();
      const org = await http().post("/v1/orgs").set(auth(owner)).send({ name: "Logo Org", slug: `logo-${Math.random().toString(36).slice(2, 10)}` });
      expect(org.status).toBe(201);
      const logo = await readyAsset(owner, "AVATAR");
      const res = await http().patch(`/v1/orgs/${org.body.slug}`).set(auth(owner)).send({ logoAssetId: logo });
      expect(res.status).toBe(200);
      expect(res.body.logoAssetId).toBe(logo);
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: logo } })).attachedAt).not.toBeNull();

      const other = await t.login();
      const foreign = await readyAsset(other, "AVATAR");
      const bad = await http().patch(`/v1/orgs/${org.body.slug}`).set(auth(owner)).send({ logoAssetId: foreign });
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe("MEDIA_NOT_USABLE");
    });
  });
});
