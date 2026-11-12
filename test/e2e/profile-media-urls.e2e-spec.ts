import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { AuthTestApp, createAuthTestApp, uniqueEmail } from "../support/auth-app";
import { checkDeclared, expectDeclared } from "../support/openapi-shape";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

describe("avatarUrl / bannerUrl on profiles and member lists", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  async function newUser(): Promise<Session & { handle: string }> {
    const s = await t.login(uniqueEmail("pm"));
    const res = await http().get("/v1/me").set(auth(s));
    expect(res.status).toBe(200);
    return { ...s, handle: res.body.profile.handle };
  }

  async function asset(s: Session, purpose: "AVATAR" | "BANNER", over: { status?: "READY" | "PROCESSING"; bucket?: "PUBLIC" | "PRIVATE" } = {}) {
    const row = await prisma.mediaAsset.create({
      data: {
        ownerId: s.userId,
        purpose,
        bucket: over.bucket ?? "PUBLIC",
        status: over.status ?? "READY",
        objectKey: `${purpose.toLowerCase()}/${s.userId}/x/source`,
        mime: "image/png",
        declaredSize: 1n,
        renditions: { "256": `${purpose.toLowerCase()}/${s.userId}/x/256.webp`, "1024": `${purpose.toLowerCase()}/${s.userId}/x/1024.webp` },
      },
    });
    return row.id;
  }

  /** Gives the user a READY public avatar and banner and returns the URLs they should be shown as. */
  async function withImages(s: Session) {
    const avatar = await asset(s, "AVATAR");
    const banner = await asset(s, "BANNER");
    await prisma.profile.update({ where: { userId: s.userId }, data: { avatarAssetId: avatar, bannerAssetId: banner } });
    return { avatarUrl: expect.stringMatching(/\/avatar\/.+\/256\.webp$/), bannerUrl: expect.stringMatching(/\/banner\/.+\/1024\.webp$/) };
  }

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
  });
  afterAll(() => t?.close());

  it("public profile shows both URLs to anyone, null without images", async () => {
    const owner = await newUser();
    const none = await http().get(`/v1/profiles/${owner.handle}`);
    expectDeclared(none, "GET /v1/profiles/{handle}");
    expect(none.body).toMatchObject({ avatarUrl: null, bannerUrl: null });
    const urls = await withImages(owner);
    const res = await http().get(`/v1/profiles/${owner.handle}`);
    expectDeclared(res, "GET /v1/profiles/{handle}");
    expect(res.body).toMatchObject(urls);
  });

  it("/v1/me and PATCH /v1/me/profile carry the URLs", async () => {
    const s = await newUser();
    const urls = await withImages(s);
    const me = await http().get("/v1/me").set(auth(s));
    expectDeclared(me, "GET /v1/me");
    expect(me.body.profile).toMatchObject(urls);
    const patched = await http().patch("/v1/me/profile").set(auth(s)).send({ headline: "hi" });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject(urls);
  });

  it("an asset that is not READY or not public gives null, not an error", async () => {
    const s = await newUser();
    const processing = await asset(s, "AVATAR", { status: "PROCESSING" });
    const priv = await asset(s, "BANNER", { bucket: "PRIVATE" });
    await prisma.profile.update({ where: { userId: s.userId }, data: { avatarAssetId: processing, bannerAssetId: priv } });
    const res = await http().get(`/v1/profiles/${s.handle}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ avatarAssetId: processing, avatarUrl: null, bannerAssetId: priv, bannerUrl: null });
  });

  it("followers and following lists carry avatarUrl (null where the member has none)", async () => {
    const star = await newUser();
    const fan = await newUser();
    const plain = await newUser();
    const fanUrls = await withImages(fan);
    const starUrls = await withImages(star);
    for (const f of [fan, plain]) expect((await http().post(`/v1/profiles/${star.handle}/follow`).set(auth(f))).status).toBe(204);
    const followers = await http().get(`/v1/profiles/${star.handle}/followers`);
    expectDeclared(followers, "GET /v1/profiles/{handle}/followers");
    const byId = new Map<string, { avatarUrl: string | null }>(followers.body.items.map((i: { id: string; avatarUrl: string | null }) => [i.id, i]));
    expect(byId.get(fan.userId)).toMatchObject({ avatarUrl: fanUrls.avatarUrl });
    expect(byId.get(plain.userId)).toMatchObject({ avatarUrl: null });
    const following = await http().get(`/v1/profiles/${fan.handle}/following`);
    expectDeclared(following, "GET /v1/profiles/{handle}/following");
    expect(following.body.items[0]).toMatchObject({ id: star.userId, avatarUrl: starUrls.avatarUrl });
  });

  it("blocks and mutes carry avatarUrl", async () => {
    const me = await newUser();
    const other = await newUser();
    const muted = await newUser();
    const otherUrls = await withImages(other);
    expect((await http().put(`/v1/blocks/${other.handle}`).set(auth(me))).status).toBe(200);
    expect((await http().put(`/v1/mutes/${muted.handle}`).set(auth(me))).status).toBe(200);
    const blocks = await http().get("/v1/me/blocks").set(auth(me));
    expectDeclared(blocks, "GET /v1/me/blocks");
    expect(blocks.body.items[0]).toMatchObject({ id: other.userId, avatarUrl: otherUrls.avatarUrl });
    const mutes = await http().get("/v1/me/mutes").set(auth(me));
    expectDeclared(mutes, "GET /v1/me/mutes");
    expect(mutes.body.items[0]).toMatchObject({ id: muted.userId, avatarUrl: null });
    void checkDeclared;
  });
});
