import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { AuthTestApp, createAuthTestApp, uniqueEmail } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

describe("profiles, follows and creator onboarding", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const me = (s: Session) => http().get("/v1/me").set(auth(s));
  const uniq = () => Math.random().toString(36).slice(2, 10);

  async function newUser(): Promise<Session & { handle: string }> {
    const s = await t.login(uniqueEmail("pf"));
    const res = await me(s);
    expect(res.status).toBe(200);
    return { ...s, handle: res.body.profile.handle };
  }

  const setHandle = (s: Session, handle: string) => http().patch("/v1/me/profile").set(auth(s)).send({ handle });

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
  });
  afterAll(() => t?.close());

  describe("GET /v1/me", () => {
    it("works right after sign-up: user, profile with derived handle, roles and permissions", async () => {
      const email = `Aftab.Khan-${uniq()}@example.com`;
      const s = await t.login(email);
      const res = await me(s);
      expect(res.status).toBe(200);
      expect(res.body.user).toEqual({ id: s.userId, email: email.toLowerCase(), status: "ACTIVE" });
      expect(res.body.profile.handle).toMatch(/^[a-z0-9_]{3,30}$/);
      expect(res.body.profile.handle.startsWith("aftabkhan")).toBe(true);
      expect(res.body.profile).toMatchObject({ isCreator: false, followersCount: 0, followingCount: 0 });
      expect(res.body.roles).toEqual(["member"]);
      expect(res.body.permissions).toEqual(expect.arrayContaining(["media.upload", "org.create"]));
      // idempotent: a second call returns the same profile
      const again = await me(s);
      expect(again.body.profile.handle).toBe(res.body.profile.handle);
    });

    it("requires authentication", async () => {
      expect((await http().get("/v1/me")).status).toBe(401);
    });
  });

  describe("PATCH /v1/me/profile", () => {
    it("updates fields and normalises the handle to lower-case", async () => {
      const s = await newUser();
      const handle = `Fresh_${uniq()}`;
      const res = await http()
        .patch("/v1/me/profile")
        .set(auth(s))
        .send({ handle, displayName: "Fresh Name", headline: "Dev", links: [{ label: "Site", url: "https://example.com" }] });
      expect(res.status).toBe(200);
      expect(res.body.handle).toBe(handle.toLowerCase());
      expect(res.body.displayName).toBe("Fresh Name");
      expect((await me(s)).body.profile.headline).toBe("Dev");
    });

    it("Review Focus 5: '@Aftab' when 'aftab' exists is HANDLE_TAKEN", async () => {
      const a = await newUser();
      const b = await newUser();
      const handle = `aftab${uniq()}`;
      expect((await setHandle(a, handle)).status).toBe(200);
      const res = await setHandle(b, `@${handle[0].toUpperCase()}${handle.slice(1)}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("HANDLE_TAKEN");
      // re-saving your own handle (any case) is fine
      expect((await setHandle(a, handle.toUpperCase())).status).toBe(200);
    });

    it.each(["admin", "API", "skiller", "support", "settings", "me", "v1"])("rejects reserved handle %s", async (reserved) => {
      const s = await newUser();
      const res = await setHandle(s, reserved);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("HANDLE_RESERVED");
    });

    it.each(["ab", "has space", "bad-dash", "x".repeat(31), "emoji\u{1F600}ok"])("rejects malformed handle %p", async (bad) => {
      const s = await newUser();
      const res = await setHandle(s, bad);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    });

    it("rejects unknown fields (avatar/banner are not wired yet)", async () => {
      const s = await newUser();
      for (const body of [{ avatarAssetId: "x" }, { bannerAssetId: "x" }, { isCreator: true }]) {
        const res = await http().patch("/v1/me/profile").set(auth(s)).send(body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_FAILED");
      }
    });
  });

  describe("replace-lists", () => {
    it("PUT experience / education / skills / portfolio replace and are served on the public profile", async () => {
      const s = await newUser();
      const exp = await http()
        .put("/v1/me/experience")
        .set(auth(s))
        .send({
          items: [
            { title: "Eng", company: "Acme", startDate: "2020-01-01", endDate: "2022-01-01" },
            { title: "Lead", company: "Beta", startDate: "2022-02-01" },
          ],
        });
      expect(exp.status).toBe(200);
      expect(exp.body.items.map((i: { title: string }) => i.title)).toEqual(["Eng", "Lead"]);
      expect(exp.body.items[0]).toMatchObject({ id: expect.any(String), title: "Eng", company: "Acme", startDate: "2020-01-01", endDate: "2022-01-01", description: null });
      const exp2 = await http().put("/v1/me/experience").set(auth(s)).send({ items: [{ title: "Only", company: "Gamma", startDate: "2023-01-01" }] });
      expect(exp2.body.items).toHaveLength(1);

      const edu = await http().put("/v1/me/education").set(auth(s)).send({ items: [{ school: "MIT", degree: "BS", startYear: 2010, endYear: 2014 }] });
      expect(edu.status).toBe(200);
      expect(edu.body.items[0]).toMatchObject({ id: expect.any(String), school: "MIT", degree: "BS", field: null, startYear: 2010, endYear: 2014 });
      const skills = await http().put("/v1/me/skills").set(auth(s)).send({ items: ["ts", "node", "ts"] });
      expect(skills.status).toBe(200);
      expect(skills.body.items).toEqual(["ts", "node"]);
      const pf = await http().put("/v1/me/portfolio").set(auth(s)).send({ items: [{ title: "Site", url: "https://example.com" }] });
      expect(pf.status).toBe(200);
      expect(pf.body.items[0]).toMatchObject({ id: expect.any(String), title: "Site", url: "https://example.com", mediaAssetId: null, description: null });

      const pub = await http().get(`/v1/profiles/${s.handle.toUpperCase()}`);
      expect(pub.status).toBe(200);
      expect(pub.body.handle).toBe(s.handle);
      expect(pub.body).toMatchObject({
        userId: s.userId,
        displayName: expect.any(String),
        followersCount: 0,
        followingCount: 0,
        isCreator: false,
        updatedAt: expect.any(String),
        experience: expect.any(Array),
        education: expect.any(Array),
        skills: expect.any(Array),
        portfolio: expect.any(Array),
      });
      expect(pub.body.experience[0]).toMatchObject({ id: expect.any(String), title: "Only", company: "Gamma", startDate: "2023-01-01", endDate: null });
      expect(pub.body.experience).toHaveLength(1);
      expect(pub.body.education).toHaveLength(1);
      expect(pub.body.skills).toEqual(["ts", "node"]);
      expect(pub.body.portfolio).toHaveLength(1);
      expect(pub.body.isFollowing).toBeUndefined();
      expect(JSON.stringify(pub.body)).not.toContain(s.email);
    });

    it("enforces list limits and element rules", async () => {
      const s = await newUser();
      const tooMany = Array.from({ length: 31 }, () => ({ title: "t", company: "c", startDate: "2020-01-01" }));
      expect((await http().put("/v1/me/experience").set(auth(s)).send({ items: tooMany })).status).toBe(400);
      expect((await http().put("/v1/me/skills").set(auth(s)).send({ items: Array.from({ length: 51 }, (_, i) => `s${i}`) })).status).toBe(400);
      expect((await http().put("/v1/me/skills").set(auth(s)).send({ items: ["x".repeat(41)] })).status).toBe(400);
      expect((await http().put("/v1/me/portfolio").set(auth(s)).send({ items: Array.from({ length: 31 }, () => ({ title: "t" })) })).status).toBe(400);
      expect((await http().put("/v1/me/education").set(auth(s)).send({ items: [{ school: "S", mediaAssetId: "x" }] })).status).toBe(400);
    });
  });

  describe("public profile", () => {
    it("404s for unknown handles", async () => {
      const res = await http().get(`/v1/profiles/nobody_${uniq()}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("PROFILE_NOT_FOUND");
    });
  });

  describe("follows", () => {
    it("follow twice keeps the count at 1; isFollowing reflects the viewer", async () => {
      const a = await newUser();
      const b = await newUser();
      const followed = await http().post(`/v1/profiles/${b.handle}/follow`).set(auth(a));
      expect(followed.status).toBe(204);
      expect(followed.text).toBe("");
      expect((await http().post(`/v1/profiles/${b.handle.toUpperCase()}/follow`).set(auth(a))).status).toBe(204);

      const pub = await http().get(`/v1/profiles/${b.handle}`).set(auth(a));
      expect(pub.body.followersCount).toBe(1);
      expect(pub.body.isFollowing).toBe(true);
      expect((await http().get(`/v1/profiles/${b.handle}`).set(auth(b))).body.isFollowing).toBe(false);
      expect((await http().get(`/v1/profiles/${b.handle}`)).body.isFollowing).toBeUndefined();
      expect((await me(a)).body.profile.followingCount).toBe(1);
      expect((await me(b)).body.profile.followersCount).toBe(1);
    });

    it("unfollowing someone you do not follow is 204 and leaves counts unchanged; real unfollow decrements", async () => {
      const a = await newUser();
      const b = await newUser();
      expect((await http().delete(`/v1/profiles/${b.handle}/follow`).set(auth(a))).status).toBe(204);
      expect((await me(b)).body.profile.followersCount).toBe(0);
      expect((await me(a)).body.profile.followingCount).toBe(0);

      await http().post(`/v1/profiles/${b.handle}/follow`).set(auth(a));
      expect((await http().delete(`/v1/profiles/${b.handle}/follow`).set(auth(a))).status).toBe(204);
      expect((await http().delete(`/v1/profiles/${b.handle}/follow`).set(auth(a))).status).toBe(204);
      expect((await me(b)).body.profile.followersCount).toBe(0);
      expect((await me(a)).body.profile.followingCount).toBe(0);
    });

    it("concurrent follows count once", async () => {
      const a = await newUser();
      const b = await newUser();
      await Promise.all(Array.from({ length: 5 }, () => http().post(`/v1/profiles/${b.handle}/follow`).set(auth(a))));
      expect((await me(b)).body.profile.followersCount).toBe(1);
    });

    it("self-follow is FOLLOW_SELF; unknown target is 404; anonymous is 401", async () => {
      const a = await newUser();
      const self = await http().post(`/v1/profiles/${a.handle}/follow`).set(auth(a));
      expect(self.status).toBe(400);
      expect(self.body.error.code).toBe("FOLLOW_SELF");
      expect((await http().post(`/v1/profiles/nobody_${uniq()}/follow`).set(auth(a))).status).toBe(404);
      expect((await http().post(`/v1/profiles/${a.handle}/follow`)).status).toBe(401);
    });

    it("followers / following are paginated", async () => {
      const target = await newUser();
      const fans = [await newUser(), await newUser(), await newUser()];
      for (const f of fans) await http().post(`/v1/profiles/${target.handle}/follow`).set(auth(f));

      const p1 = await http().get(`/v1/profiles/${target.handle}/followers?limit=2`);
      expect(p1.status).toBe(200);
      expect(p1.body.items).toHaveLength(2);
      expect(p1.body.nextCursor).toBeTruthy();
      const p2 = await http().get(`/v1/profiles/${target.handle}/followers?limit=2&cursor=${p1.body.nextCursor}`);
      expect(p2.body.items).toHaveLength(1);
      expect(p2.body.nextCursor).toBeNull();
      const ids = [...p1.body.items, ...p2.body.items].map((i: { id: string }) => i.id).sort();
      expect(ids).toEqual(fans.map((f) => f.userId).sort());
      expect(p1.body.items[0]).toMatchObject({ id: expect.any(String), handle: expect.any(String), displayName: expect.any(String), headline: null, avatarAssetId: null });

      const following = await http().get(`/v1/profiles/${fans[0].handle}/following`);
      expect(following.body.items.map((i: { id: string }) => i.id)).toEqual([target.userId]);
    });
  });

  describe("become-creator", () => {
    it("grants creator, flips isCreator, emits exactly one user.became_creator; repeat is a 200 no-op", async () => {
      const s = await newUser();
      const noTerms = await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: false });
      expect(noTerms.status).toBe(400);

      const first = await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true });
      expect(first.status).toBe(200);
      const second = await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true });
      expect(second.status).toBe(200);

      const body = (await me(s)).body;
      expect(body.profile.isCreator).toBe(true);
      expect([...body.roles].sort()).toEqual(["creator", "member"]);

      const events = await prisma.outboxEvent.findMany({ where: { type: "user.became_creator", payload: { path: ["userId"], equals: s.userId } } });
      expect(events).toHaveLength(1);
    });
  });
});
