import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);

/** Carried fix: the unread count and the pages agree with what the list shows when moderation hides a notification's subject. */
describe("notifications: hidden items are not counted, pages still fill", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  const reel = async (creatorId: string, status: "PUBLISHED" | "HIDDEN") => {
    const a = await prisma.mediaAsset.create({ data: { ownerId: creatorId, purpose: "REEL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30 } });
    return prisma.reel.create({ data: { creatorId, mediaAssetId: a.id, caption: "", hashtags: [], status, publishedAt: new Date() } });
  };
  const like = (userId: string, reelId: string) => prisma.notification.create({ data: { userId, type: "reel.like", title: "t", body: "b", data: { reelId } } });

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
  });
  afterAll(() => t?.close());

  it("unread-count leaves out what the list hides; limit-sized pages fill past hidden rows with stable cursors", async () => {
    const me = await t.login();
    const live = await reel(me.userId, "PUBLISHED");
    const gone = await reel(me.userId, "HIDDEN");
    // oldest -> newest: live, gone x2, live, gone x3, live, gone x2  => newest first: G G L G G G L G G L
    const order = [live, gone, gone, live, gone, gone, gone, live, gone, gone];
    const liveIds: string[] = [];
    for (const r of order) {
      const n = await like(me.userId, r.id);
      if (r === live) liveIds.push(n.id);
    }
    expect((await http().get("/v1/notifications/unread-count").set(auth(me))).body).toEqual({ count: 3 });

    const seen: string[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await http().get(`/v1/notifications?limit=2${cursor ? `&cursor=${cursor}` : ""}`).set(auth(me));
      expect(res.status).toBe(200);
      sizes.push(res.body.items.length);
      seen.push(...res.body.items.map((n: { id: string }) => n.id));
      cursor = res.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(sizes).toEqual([2, 1]); // the first page is full although seven hidden rows sit among the first nine
    expect(seen).toEqual([...liveIds].reverse());

    // reading one reduces the count; the unread filter is filtered the same way
    await http().post(`/v1/notifications/${liveIds[2]}/read`).set(auth(me)).expect(200);
    expect((await http().get("/v1/notifications/unread-count").set(auth(me))).body).toEqual({ count: 2 });
    expect((await http().get("/v1/notifications?unread=true&limit=5").set(auth(me))).body.items).toHaveLength(2);
  });
});
