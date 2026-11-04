import { randomUUID } from "node:crypto";
import request from "supertest";
import { EventBus } from "../../src/common/outbox/event-bus";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { istDateOf, istDayRange } from "../../src/modules/billing";
import { givePlan } from "../support/billing";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);

/** Review Focus 4: the posting limit cannot be bypassed by parallel publishes, delete-and-repost or the IST midnight boundary. */
describe("reel posting limit (reels_per_day, per IST day)", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  /** The fake clock to 23:59:40 IST of its current day, before anyone logs in (tokens are issued against the same clock). */
  const toBeforeIstMidnight = () => {
    const { to } = istDayRange(istDateOf(t.clock.now()));
    t.clock.advance(to.getTime() - 20_000 - t.clock.now().getTime());
  };

  async function creator(plan = "free") {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    await givePlan(prisma, "USER", s.userId, plan);
    return s;
  }
  const asset = (ownerId: string, status: "READY" | "PROCESSING" = "READY") =>
    prisma.mediaAsset.create({ data: { ownerId, purpose: "REEL", bucket: "PUBLIC", status, objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30 } });
  const post = async (s: Session, status: "READY" | "PROCESSING" = "READY") => http().post("/v1/reels").set(auth(s)).send({ mediaAssetId: (await asset(s.userId, status)).id, caption: "limit test" });
  const statuses = async (userId: string) => (await prisma.reel.findMany({ where: { creatorId: userId } })).map((r) => r.status).sort();
  const published = (userId: string) => prisma.reel.count({ where: { creatorId: userId, status: "PUBLISHED" } });

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    toBeforeIstMidnight();
  });
  afterAll(() => t?.close());

  it("parallel publishes never exceed the plan: 8 posts at once on Free (3 a day) publish exactly 3", async () => {
    const me = await creator("free");
    const results = await Promise.all(Array.from({ length: 8 }, () => post(me)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await published(me.userId)).toBe(3);
    expect(await statuses(me.userId)).toEqual(["LIMIT_REACHED", "LIMIT_REACHED", "LIMIT_REACHED", "LIMIT_REACHED", "LIMIT_REACHED", "PUBLISHED", "PUBLISHED", "PUBLISHED"]);
    expect(await prisma.notification.count({ where: { userId: me.userId, type: "reel.limit_reached" } })).toBe(5);
  });

  it("parallel media.ready events publish at most the limit too", async () => {
    const me = await creator("free");
    const posted = await Promise.all(Array.from({ length: 6 }, () => post(me, "PROCESSING")));
    const bus = t.app.get(EventBus);
    await Promise.all(
      posted.map(async (res) => {
        const row = await prisma.reel.findUniqueOrThrow({ where: { id: res.body.id } });
        await prisma.mediaAsset.update({ where: { id: row.mediaAssetId }, data: { status: "READY" } });
        await bus.dispatch({ type: "media.ready", assetId: row.mediaAssetId, ownerId: me.userId, purpose: "reel" }, `ready-${row.mediaAssetId}`);
      }),
    );
    expect(await published(me.userId)).toBe(3);
    expect((await statuses(me.userId)).filter((s) => s === "LIMIT_REACHED")).toHaveLength(3);
  });

  it("deleting a published reel does not give the slot back", async () => {
    const me = await creator("free");
    const made = [];
    for (let i = 0; i < 3; i++) made.push((await post(me)).body);
    expect(made.map((r) => r.status)).toEqual(["PUBLISHED", "PUBLISHED", "PUBLISHED"]);
    await http().delete(`/v1/reels/${made[0].id}`).set(auth(me)).expect(204);
    const repost = await post(me);
    expect(repost.status).toBe(201);
    expect(repost.body.status).toBe("LIMIT_REACHED");
    expect(await published(me.userId)).toBe(2);
    const row = await prisma.reel.findUniqueOrThrow({ where: { id: made[0].id } });
    expect(row).toMatchObject({ status: "DELETED" });
    expect(row.publishedAt).not.toBeNull();
  });

  it("retrying a LIMIT_REACHED reel fails while the day is full and works after IST midnight", async () => {
    const me = await creator("free");
    for (let i = 0; i < 3; i++) await post(me);
    const waiting = (await post(me)).body;
    expect(waiting.status).toBe("LIMIT_REACHED");
    const retry = () => http().post(`/v1/reels/${waiting.id}/publish`).set(auth(me));
    const full = await retry();
    expect(full.status).toBe(403);
    expect(full.body.error.code).toBe("ENTITLEMENT_LIMIT_REACHED");
    expect((await prisma.reel.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe("LIMIT_REACHED");
    // someone else cannot publish it
    const stranger = await creator("free");
    expect((await http().post(`/v1/reels/${waiting.id}/publish`).set(auth(stranger))).status).toBe(404);

    t.clock.advanceSec(30); // past IST midnight
    const next = await retry();
    expect(next.status).toBe(200);
    expect(next.body.status).toBe("PUBLISHED");
    expect(await retry().then((r) => [r.status, r.body.status])).toEqual([200, "PUBLISHED"]);
    expect(await published(me.userId)).toBe(4); // 3 yesterday + 1 today
  });
});
