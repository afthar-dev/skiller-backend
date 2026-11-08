import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import { BURST, pinSmallPool, statuses } from "../support/small-pool";

const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);

/**
 * Creating or editing a gig with a cover checks the asset (owner, purpose, state) before attaching it. That read used the global client
 * inside the gig's transaction, so parallel requests on a small pool each held a connection while waiting for another (P2024, 500).
 */
describe("gig media with a small connection pool", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let categoryId: string;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const creator = async () => {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    return s;
  };
  const asset = (ownerId: string, purpose: "THUMBNAIL" | "GIG_GALLERY") =>
    prisma.mediaAsset.create({ data: { ownerId, purpose, bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "image/png", declaredSize: 10n } });
  const body = (over: Record<string, unknown> = {}) => ({
    title: `Logo design ${uniq()}`,
    description: "I design logos.",
    categoryId,
    tags: ["logo"],
    packages: [{ tier: "BASIC", name: "Basic pack", description: "What you get", pricePaise: "49900", deliveryDays: 3, revisions: 2, features: ["one"] }],
    ...over,
  });

  beforeAll(async () => {
    pinSmallPool();
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  it("parallel gig creations with a cover and a gallery all succeed", async () => {
    const sellers = await Promise.all(Array.from({ length: BURST }, () => creator()));
    const covers = await Promise.all(sellers.map((s) => asset(s.userId, "THUMBNAIL")));
    const pictures = await Promise.all(sellers.map((s) => asset(s.userId, "GIG_GALLERY")));
    const res = await Promise.all(sellers.map((s, i) => http().post("/v1/studio/gigs").set(auth(s)).send(body({ coverAssetId: covers[i].id, galleryAssetIds: [pictures[i].id] }))));
    expect(statuses(res)).toEqual(Array(BURST).fill(201));
  });

  it("parallel cover changes on existing gigs all succeed, and someone else's asset is still refused", async () => {
    const sellers = await Promise.all(Array.from({ length: BURST }, () => creator()));
    const gigs = await Promise.all(sellers.map(async (s) => (await http().post("/v1/studio/gigs").set(auth(s)).send(body())).body as { id: string }));
    const covers = await Promise.all(sellers.map((s) => asset(s.userId, "THUMBNAIL")));
    const res = await Promise.all(gigs.map((g, i) => http().patch(`/v1/studio/gigs/${g.id}`).set(auth(sellers[i])).send({ coverAssetId: covers[i].id })));
    expect(statuses(res)).toEqual(Array(BURST).fill(200));

    const theirs = await asset(sellers[1].userId, "THUMBNAIL");
    const refused = await http().patch(`/v1/studio/gigs/${gigs[0].id}`).set(auth(sellers[0])).send({ coverAssetId: theirs.id });
    expect(refused.status).toBe(422);
  });
});
