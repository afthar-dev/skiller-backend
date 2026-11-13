import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);

describe("GET /v1/studio/reels", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  const asset = (ownerId: string) =>
    prisma.mediaAsset.create({ data: { ownerId, purpose: "REEL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30, posterKey: `reel/${uniq()}/poster.jpg` } });
  const reel = async (creatorId: string, status: string, createdAt: Date, caption = status) =>
    prisma.reel.create({ data: { creatorId, mediaAssetId: (await asset(creatorId)).id, caption, hashtags: [], status: status as never, createdAt, publishedAt: status === "PUBLISHED" ? createdAt : null } });

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
  });
  afterAll(() => t?.close());

  it("lists my reels in every state but deleted, newest first, and nobody else's", async () => {
    const me = await t.login();
    const other = await t.login();
    const base = Date.now() - 100_000;
    const states = ["PROCESSING", "PUBLISHED", "LIMIT_REACHED", "FAILED", "HIDDEN", "REMOVED", "DELETED"];
    const mine = [];
    for (const [i, status] of states.entries()) mine.push(await reel(me.userId, status, new Date(base + i * 1000)));
    await reel(other.userId, "PUBLISHED", new Date(base + 50_000));

    const res = await http().get("/v1/studio/reels").set(auth(me));
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items.map((r: { id: string }) => r.id)).toEqual(
      mine
        .filter((r) => r.status !== "DELETED")
        .reverse()
        .map((r) => r.id),
    );
    expect(res.body.items.map((r: { status: string }) => r.status)).toEqual(["REMOVED", "HIDDEN", "FAILED", "LIMIT_REACHED", "PUBLISHED", "PROCESSING"]);
  });

  it("pages with a signed cursor without repeats, and refuses a forged one", async () => {
    const me = await t.login();
    const base = Date.now() - 100_000;
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await reel(me.userId, "PUBLISHED", new Date(base + i * 1000), `r${i}`));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 5; guard++) {
      const res: request.Response = await http().get(`/v1/studio/reels?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`).set(auth(me));
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((r: { id: string }) => r.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(made.map((r) => r.id).reverse());
    expect((await http().get("/v1/studio/reels?cursor=forged").set(auth(me))).status).toBe(400);
  });

  it("needs a signed-in caller, and an empty list is a normal answer", async () => {
    expect((await http().get("/v1/studio/reels")).status).toBe(401);
    const me = await t.login();
    const res = await http().get("/v1/studio/reels").set(auth(me));
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });
});
