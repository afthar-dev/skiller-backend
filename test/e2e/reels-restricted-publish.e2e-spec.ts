import { randomUUID } from "node:crypto";
import request from "supertest";
import { EventBus } from "../../src/common/outbox/event-bus";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { givePlan } from "../support/billing";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);

/** Carried fix: a video that finishes processing while its creator is under a posting ban must not go live. */
describe("auto-publish respects the posting ban", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
  });
  afterAll(() => t?.close());

  it("media.ready under a ban parks the reel (not live, creator told); publishing is refused during the ban and works after it", async () => {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    await givePlan(prisma, "USER", s.userId, "free");
    const asset = await prisma.mediaAsset.create({ data: { ownerId: s.userId, purpose: "REEL", bucket: "PUBLIC", status: "PROCESSING", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30 } });
    const posted = await http().post("/v1/reels").set(auth(s)).send({ mediaAssetId: asset.id, caption: "banned soon #restricted" });
    expect(posted.status).toBe(201);
    expect(posted.body.status).toBe("PROCESSING");

    const until = new Date(t.clock.now().getTime() + 7 * 86_400_000);
    await prisma.userRestriction.create({ data: { userId: s.userId, until, reason: "strikes" } });
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });
    const eventId = randomUUID();
    const event = { type: "media.ready" as const, assetId: asset.id, ownerId: s.userId, purpose: "reel" };
    await t.app.get(EventBus).dispatch(event, eventId);
    await t.app.get(EventBus).dispatch(event, eventId); // redelivery

    const row = await prisma.reel.findUniqueOrThrow({ where: { id: posted.body.id } });
    expect(row.status).toBe("LIMIT_REACHED");
    expect(row.failureReason).toBe("POSTING_RESTRICTED");
    expect(row.publishedAt).toBeNull();
    expect(await prisma.hashtag.findUnique({ where: { tag: "restricted" } })).toBeNull();
    const notes = await prisma.notification.findMany({ where: { userId: s.userId, type: "reel.restricted" } });
    expect(notes).toHaveLength(1);
    expect((await http().get(`/v1/reels/${row.id}`)).status).toBe(404);

    const during = await http().post(`/v1/reels/${row.id}/publish`).set(auth(s));
    expect([during.status, during.body.error.code]).toEqual([403, "POSTING_RESTRICTED"]);

    await prisma.userRestriction.update({ where: { userId: s.userId }, data: { until: new Date(t.clock.now().getTime() - 1000) } }); // the ban ends
    const after = await http().post(`/v1/reels/${row.id}/publish`).set(auth(s));
    expect([after.status, after.body.status]).toEqual([200, "PUBLISHED"]);
    expect((await http().get(`/v1/reels/${row.id}`)).status).toBe(200);
  });
});
