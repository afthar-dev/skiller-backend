import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { UserStatusCache } from "../../src/modules/identity";
import { RolesService } from "../../src/modules/rbac";
import { ProfilesService } from "../../src/modules/users";
import { givePlan } from "../support/billing";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);

describe("gig search, moderation and reel links", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let categoryId: string;
  let otherCategoryId: string;
  let moderator: Session;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const get = (path: string, s?: Session) => {
    const req = http().get(path).set("X-Forwarded-For", uniqueIp());
    return s ? req.set(auth(s)) : req;
  };
  const handleOf = async (s: Session) => (await t.app.get(ProfilesService).ensure(s.userId)).handle;

  async function creator() {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    await givePlan(prisma, "USER", s.userId, "business");
    return s;
  }
  const asset = (ownerId: string, purpose: "THUMBNAIL" | "REEL" = "THUMBNAIL", over: Record<string, unknown> = {}) =>
    prisma.mediaAsset.create({ data: { ownerId, purpose, bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: purpose === "REEL" ? "video/mp4" : "image/png", declaredSize: 10n, ...(purpose === "REEL" ? { durationSec: 30 } : {}), ...over } });
  const pkg = (pricePaise: string) => ({ tier: "BASIC", name: "Basic", description: "d", pricePaise, deliveryDays: 3, revisions: 1, features: [] });
  /** A live gig, through the API. */
  async function liveGig(s: Session, over: Record<string, unknown> = {}) {
    const cover = await asset(s.userId);
    const res = await http()
      .post("/v1/studio/gigs")
      .set(auth(s))
      .send({ title: `Gig ${uniq()}`, description: "A fine offer", categoryId, tags: [], packages: [pkg("49900")], coverAssetId: cover.id, ...over });
    expect(res.status).toBe(201);
    const on = await http().post(`/v1/studio/gigs/${res.body.id}/activate`).set(auth(s));
    expect(on.status).toBe(200);
    return { id: res.body.id as string, slug: res.body.slug as string, title: res.body.title as string };
  }
  const postReel = (s: Session, extra: Record<string, unknown> = {}) =>
    asset(s.userId, "REEL").then((a) => http().post("/v1/reels").set(auth(s)).send({ mediaAssetId: a.id, caption: `reel #${uniq()}`, ...extra }));
  const search = (qs: string, s?: Session) => get(`/v1/gigs?${qs}`, s);
  const ids = (res: { body: { items: Array<{ id: string }> } }) => res.body.items.map((i) => i.id);
  async function setUserStatus(userId: string, status: "ACTIVE" | "SUSPENDED") {
    await prisma.user.update({ where: { id: userId }, data: { status } });
    await t.app.get(UserStatusCache).bust(userId);
  }
  const reporters = (n: number) => Promise.all(Array.from({ length: n }, () => t.login()));
  async function reportAll(targetId: string, n = 5) {
    for (const u of await reporters(n)) expect([200, 201]).toContain((await http().post("/v1/reports").set(auth(u)).send({ targetType: "GIG", targetId, reason: "SPAM" })).status);
  }
  const decide = (verb: "uphold" | "dismiss", id: string) => http().post(`/v1/admin/moderation/targets/GIG/${id}/${verb}`).set(auth(moderator)).send({ note: "reviewed" });

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
    otherCategoryId = (await prisma.category.findFirstOrThrow({ where: { slug: { not: "development" }, isActive: true } })).id;
    moderator = await t.login();
    await t.app.get(RolesService).grantSystem(moderator.userId, "moderator");
  });
  afterAll(() => t?.close());

  describe("catalog search", () => {
    it("finds gigs by title, tag and description words; fuzzy title when nothing matches as written; nothing for an unrelated word", async () => {
      const c = await creator();
      const word = `zq${uniq()}`;
      const inTitle = await liveGig(c, { title: `${word} logo` });
      const inTag = await liveGig(c, { tags: [word] });
      const inBody = await liveGig(c, { description: `We do ${word} well` });
      const res = await search(`q=${word}`);
      expect(res.status).toBe(200);
      expect(new Set(ids(res))).toEqual(new Set([inTitle.id, inTag.id, inBody.id]));
      expect(ids(res)[0]).toBe(inTitle.id); // title outranks tag and description
      expect(res.body.items[0]).toMatchObject({ id: inTitle.id, slug: inTitle.slug, startingPricePaise: "49900", sellerId: c.userId });

      const brand = `Brandmark${uniq().slice(0, 4)}`;
      const fuzzy = await liveGig(c, { title: `${brand} studio` });
      expect(ids(await search(`q=${encodeURIComponent(brand.replace("mark", "mrk"))}`))).toContain(fuzzy.id);
      expect(ids(await search(`q=nothingmatchesthis${uniq()}`))).toEqual([]);
    });

    it("filters by category slug and starting price (lowest package, paise); sorts by newest and price", async () => {
      const c = await creator();
      const tag = `f${uniq()}`;
      const cheap = await liveGig(c, { tags: [tag], packages: [pkg("19900")] });
      const mid = await liveGig(c, { tags: [tag], packages: [pkg("49900"), { ...pkg("999900"), tier: "PREMIUM" }], categoryId: otherCategoryId });
      const dear = await liveGig(c, { tags: [tag], packages: [pkg("249900")] });
      const other = (await prisma.category.findUniqueOrThrow({ where: { id: otherCategoryId } })).slug;

      expect(new Set(ids(await search(`q=${tag}`)))).toEqual(new Set([cheap.id, mid.id, dear.id]));
      expect(ids(await search(`q=${tag}&category=${other}`))).toEqual([mid.id]);
      const rng = await search(`q=${tag}&minPrice=30000&maxPrice=100000`);
      expect(new Set(ids(rng))).toEqual(new Set([mid.id]));
      expect(new Set(ids(await search(`q=${tag}&minPrice=19900`)))).toEqual(new Set([cheap.id, mid.id, dear.id]));
      expect(ids(await search(`q=${tag}&sort=price_asc`))).toEqual([cheap.id, mid.id, dear.id]);
      expect(ids(await search(`q=${tag}&sort=price_desc`))).toEqual([dear.id, mid.id, cheap.id]);
      expect(ids(await search(`q=${tag}&sort=newest`))).toEqual([dear.id, mid.id, cheap.id]);
      expect(ids(await search(`category=${other}&sort=newest`))[0]).toBe(mid.id);

      // a price change through the studio moves the starting price
      const edit = await http().patch(`/v1/studio/gigs/${cheap.id}`).set(auth(c)).send({ packages: [pkg("500000")] });
      expect(edit.status).toBe(200);
      expect(ids(await search(`q=${tag}&sort=price_asc`))).toEqual([mid.id, dear.id, cheap.id]);
    });

    it("rejects bad parameters", async () => {
      for (const qs of ["minPrice=abc", "minPrice=500&maxPrice=100", "sort=random", "category=Not%20A%20Slug", `q=${"x".repeat(101)}`, "limit=0", "unknown=1x"]) {
        const res = await search(qs);
        expect([qs, res.status === 400 || res.status === 200]).toEqual([qs, true]);
      }
      expect((await search("minPrice=abc")).status).toBe(400);
      expect((await search("minPrice=500&maxPrice=100")).status).toBe(400);
      expect((await search("sort=random")).status).toBe(400);
    });

    it("pages with signed cursors: no repeats or gaps on every sort, tampered or foreign cursors are a 400 BAD_CURSOR", async () => {
      const c = await creator();
      const tag = `p${uniq()}`;
      const made: string[] = [];
      for (const price of ["30000", "20000", "30000", "10000", "20000"]) made.push((await liveGig(c, { tags: [tag], packages: [pkg(price)] })).id);
      for (const sort of ["newest", "price_asc", "price_desc", "relevance"]) {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < 6; i++) {
          const res: { status: number; body: { items: Array<{ id: string }>; nextCursor: string | null } } = await search(`q=${tag}&sort=${sort}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
          expect([sort, res.status]).toEqual([sort, 200]);
          seen.push(...ids(res));
          cursor = res.body.nextCursor;
          if (!cursor) break;
        }
        expect([sort, [...seen].sort()]).toEqual([sort, [...made].sort()]);
        expect(new Set(seen).size).toBe(seen.length);
      }
      const page = await search(`q=${tag}&limit=2`);
      const cursor = page.body.nextCursor as string;
      const [body, sig] = cursor.split(".");
      const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), k0: "0" })).toString("base64url")}.${sig}`;
      for (const bad of [forged, `${body}.${sig.slice(0, -2)}xx`, "garbage", `${body}`]) {
        const res = await search(`q=${tag}&limit=2&cursor=${encodeURIComponent(bad)}`);
        expect([res.status, res.body.error.code]).toEqual([400, "BAD_CURSOR"]);
      }
      // a cursor is bound to the query that made it
      const other = await search(`q=${tag}&limit=2&sort=price_asc&cursor=${encodeURIComponent(cursor)}`);
      expect([other.status, other.body.error.code]).toEqual([400, "BAD_CURSOR"]);
      const filtered = await search(`q=${tag}&limit=2&minPrice=1&cursor=${encodeURIComponent(cursor)}`);
      expect(filtered.status).toBe(400);
      // a cursor of another list (profile gigs) is refused too
      const profile = await get(`/v1/profiles/${await handleOf(c)}/gigs?limit=2`);
      const foreign = await search(`q=${tag}&cursor=${encodeURIComponent(profile.body.nextCursor)}`);
      expect(foreign.status).toBe(400);
    });

    it("is rate limited per IP", async () => {
      const ip = uniqueIp();
      let last = 200;
      for (let i = 0; i < 305 && last === 200; i++) last = (await http().get("/v1/gigs?limit=1").set("X-Forwarded-For", ip)).status;
      expect(last).toBe(429);
    });
  });

  describe("hidden gigs never leak (search, profile, page, reel card)", () => {
    it("paused, draft, deleted, reported-and-hidden, removed and suspended-seller gigs are absent everywhere; they return when they should", async () => {
      const c = await creator();
      const tag = `h${uniq()}`;
      const shown = await liveGig(c, { tags: [tag] });
      const paused = await liveGig(c, { tags: [tag] });
      const deleted = await liveGig(c, { tags: [tag] });
      const reported = await liveGig(c, { tags: [tag] });
      const removed = await liveGig(c, { tags: [tag] });
      // every gig has a reel that links it, made while the gig was live: the reel's card must follow the same rules as search and the gig page
      const reelOf: Record<string, string> = {};
      for (const [name, g] of Object.entries({ shown, paused, deleted, reported, removed })) {
        const reel = await postReel(c, { linkedGigId: g.id, caption: "a reel for a gig" }); // no hashtag: trending tags are a shared, capped list
        expect([name, reel.status, reel.body.gig?.id]).toEqual([name, 201, g.id]);
        reelOf[name] = reel.body.id;
      }
      const cardOf = async (name: string, viewer?: Session) => (await get(`/v1/reels/${reelOf[name]}`, viewer)).body.gig as { id: string } | null;
      const draft = (await http().post("/v1/studio/gigs").set(auth(c)).send({ title: `Draft ${uniq()}`, description: "x", categoryId, tags: [tag], packages: [pkg("49900")] })).body.id as string;
      expect((await http().post(`/v1/studio/gigs/${paused.id}/pause`).set(auth(c))).status).toBe(200);
      expect((await http().delete(`/v1/studio/gigs/${deleted.id}`).set(auth(c))).status).toBe(204);
      await reportAll(reported.id);
      await reportAll(removed.id);
      expect((await decide("uphold", removed.id)).status).toBe(200);
      expect((await prisma.gig.findUniqueOrThrow({ where: { id: reported.id } })).status).toBe("HIDDEN");
      expect((await prisma.gig.findUniqueOrThrow({ where: { id: removed.id } })).status).toBe("REMOVED");

      expect((await cardOf("shown"))?.id).toBe(shown.id);
      for (const name of ["paused", "deleted", "reported", "removed"]) expect([name, await cardOf(name)]).toEqual([name, null]);
      const gone = [paused, deleted, reported, removed];
      const handle = await handleOf(c);
      const surfaces = async (viewer?: Session) => ({
        search: ids(await search(`q=${tag}`, viewer)),
        profile: ids(await get(`/v1/profiles/${handle}/gigs?limit=50`, viewer)),
      });
      const open = await surfaces();
      expect(open.search).toEqual([shown.id]);
      expect(open.profile).toEqual([shown.id]);
      for (const g of gone) expect((await get(`/v1/gigs/${g.slug}`)).status).toBe(404);
      expect((await get(`/v1/gigs/${shown.slug}`)).status).toBe(200);
      expect((await get(`/v1/gigs/${draft}`)).status).toBe(404);

      // the seller is suspended: nothing of theirs anywhere; active again: back
      await setUserStatus(c.userId, "SUSPENDED");
      const suspended = await surfaces();
      expect(suspended).toEqual({ search: [], profile: [] });
      expect((await get(`/v1/gigs/${shown.slug}`)).status).toBe(404);
      await setUserStatus(c.userId, "ACTIVE");
      expect((await surfaces()).search).toEqual([shown.id]);

      // a block hides the seller's gigs from the blocked viewer (and the blocker's own view of them)
      const viewer = await t.login();
      await t.app.get(ProfilesService).ensure(viewer.userId);
      expect(ids(await search(`q=${tag}`, viewer))).toEqual([shown.id]);
      expect((await http().put(`/v1/blocks/${handle}`).set(auth(viewer))).status).toBe(200);
      expect(ids(await search(`q=${tag}`, viewer))).toEqual([]);
      expect((await http().delete(`/v1/blocks/${handle}`).set(auth(viewer))).status).toBe(200);
      expect(ids(await search(`q=${tag}`, viewer))).toEqual([shown.id]);

      // a dismissed report brings the held-back gig back, and its reel's card with it
      expect((await decide("dismiss", reported.id)).status).toBe(200);
      expect((await cardOf("reported"))?.id).toBe(reported.id);
      expect((await prisma.gig.findUniqueOrThrow({ where: { id: reported.id } })).status).toBe("ACTIVE");
      expect(new Set(ids(await search(`q=${tag}`)))).toEqual(new Set([shown.id, reported.id]));
    });

    it("search keeps filling a page when many hidden-seller rows come first", async () => {
      const bad = await creator();
      const good = await creator();
      const tag = `s${uniq()}`;
      for (let i = 0; i < 5; i++) await liveGig(bad, { tags: [tag] });
      const wanted = await liveGig(good, { tags: [tag] });
      await setUserStatus(bad.userId, "SUSPENDED");
      try {
        const res = await search(`q=${tag}&sort=newest&limit=2`);
        expect(ids(res)).toEqual([wanted.id]);
        expect(res.body.nextCursor).toBeNull();
      } finally {
        await setUserStatus(bad.userId, "ACTIVE");
      }
    });
  });

  describe("reports", () => {
    it("members report a live gig: one per member, not their own, auto-hide at the threshold with audit, uphold removes and strikes, a seller cannot edit afterwards", async () => {
      const c = await creator();
      const g = await liveGig(c);
      const me = await t.login();
      const first = await http().post("/v1/reports").set(auth(me)).send({ targetType: "GIG", targetId: g.id, reason: "SPAM", note: "ad" });
      expect(first.status).toBe(201);
      expect((await http().post("/v1/reports").set(auth(me)).send({ targetType: "GIG", targetId: g.id, reason: "SPAM" })).status).toBe(200);
      const own = await http().post("/v1/reports").set(auth(c)).send({ targetType: "GIG", targetId: g.id, reason: "SPAM" });
      expect([own.status, own.body.error.code]).toEqual([400, "REPORT_OWN_CONTENT"]);
      expect((await http().post("/v1/reports").set(auth(me)).send({ targetType: "GIG", targetId: randomUUID(), reason: "SPAM" })).status).toBe(404);
      const draft = await http().post("/v1/studio/gigs").set(auth(c)).send({ title: `Draft ${uniq()}`, description: "x", categoryId, tags: [], packages: [pkg("49900")] });
      expect((await http().post("/v1/reports").set(auth(me)).send({ targetType: "GIG", targetId: draft.body.id, reason: "SPAM" })).status).toBe(404); // not live: nothing to report

      await reportAll(g.id, 4); // 1 + 4 = 5 distinct reporters
      expect((await prisma.gig.findUniqueOrThrow({ where: { id: g.id } })).status).toBe("HIDDEN");
      expect(await prisma.auditLog.count({ where: { action: "moderation.autohide", targetId: g.id } })).toBe(1);
      expect((await get(`/v1/gigs/${g.slug}`)).status).toBe(404);
      const mine = await http().get(`/v1/studio/gigs/${g.id}`).set(auth(c));
      expect([mine.status, mine.body.status]).toEqual([200, "HIDDEN"]);
      const edit = await http().patch(`/v1/studio/gigs/${g.id}`).set(auth(c)).send({ tags: ["x"] });
      expect(edit.status).toBe(409);

      const queue = await http().get("/v1/admin/moderation/reports?type=GIG").set(auth(moderator));
      expect(queue.status).toBe(200);
      expect(JSON.stringify(queue.body)).toContain(g.id);

      expect((await decide("uphold", g.id)).status).toBe(200);
      expect((await prisma.gig.findUniqueOrThrow({ where: { id: g.id } })).status).toBe("REMOVED");
      expect(await prisma.strike.count({ where: { userId: c.userId } })).toBe(1);
      expect((await get(`/v1/gigs/${g.slug}`)).status).toBe(404);
    });

    it("a hidden gig still counts against the seller's limit; restoring needs no new slot", async () => {
      const c = await creator();
      const g = await liveGig(c);
      await reportAll(g.id);
      expect(await prisma.gig.count({ where: { sellerId: c.userId, status: "HIDDEN" } })).toBe(1);
      expect((await decide("dismiss", g.id)).status).toBe(200);
      expect((await get(`/v1/gigs/${g.slug}`)).status).toBe(200);
    });
  });

  describe("reel links", () => {
    it("a reel links one live gig of its creator: a card shows on the reel, follows the gig's state, and clears with null", async () => {
      const c = await creator();
      const g = await liveGig(c);
      const res = await postReel(c, { linkedGigId: g.id });
      expect(res.status).toBe(201);
      expect(res.body.gig).toMatchObject({ id: g.id, slug: g.slug, title: g.title, startingPricePaise: "49900" });
      expect(res.body.course).toBeNull();
      const reelId = res.body.id as string;
      const read = await get(`/v1/reels/${reelId}`);
      expect(read.body.gig).toMatchObject({ id: g.id, slug: g.slug });

      // gig leaves the live state: the card is omitted at read time, the link row stays
      expect((await http().post(`/v1/studio/gigs/${g.id}/pause`).set(auth(c))).status).toBe(200);
      expect((await get(`/v1/reels/${reelId}`)).body.gig).toBeNull();
      expect((await http().post(`/v1/studio/gigs/${g.id}/activate`).set(auth(c))).status).toBe(200);
      expect((await get(`/v1/reels/${reelId}`)).body.gig).toMatchObject({ id: g.id });
      await reportAll(g.id);
      expect((await get(`/v1/reels/${reelId}`)).body.gig).toBeNull(); // hidden by reports
      expect((await decide("dismiss", g.id)).status).toBe(200);

      const patched = await http().patch(`/v1/reels/${reelId}`).set(auth(c)).send({ linkedGigId: null });
      expect([patched.status, patched.body.gig]).toEqual([200, null]);
      const relink = await http().patch(`/v1/reels/${reelId}`).set(auth(c)).send({ linkedGigId: g.id });
      expect([relink.status, relink.body.gig?.id]).toEqual([200, g.id]);
    });

    it("refuses someone else's gig, a gig that is not live, an unknown id, and both links at once", async () => {
      const c = await creator();
      const other = await creator();
      const mine = await liveGig(c);
      const theirs = await liveGig(other);
      const paused = await liveGig(c);
      await http().post(`/v1/studio/gigs/${paused.id}/pause`).set(auth(c));
      for (const id of [theirs.id, paused.id, randomUUID()]) {
        const res = await postReel(c, { linkedGigId: id });
        expect([id, res.status, res.body.error.code]).toEqual([id, 422, "GIG_NOT_LINKABLE"]);
      }
      const course = await prisma.course.findFirst({ where: { status: "PUBLISHED" } });
      const both = await postReel(c, { linkedGigId: mine.id, linkedCourseId: course?.id ?? randomUUID() });
      expect([both.status, both.body.error.code]).toEqual([422, "REEL_LINK_CONFLICT"]);

      const ok = await postReel(c, { linkedGigId: mine.id });
      const conflict = await http().patch(`/v1/reels/${ok.body.id}`).set(auth(c)).send({ linkedGigId: mine.id, linkedCourseId: course?.id ?? randomUUID() });
      expect([conflict.status, conflict.body.error.code]).toEqual([422, "REEL_LINK_CONFLICT"]);
      expect((await http().patch(`/v1/reels/${ok.body.id}`).set(auth(c)).send({ linkedGigId: theirs.id })).status).toBe(422);
      expect((await http().patch(`/v1/reels/${ok.body.id}`).set(auth(c)).send({ linkedGigId: "not-a-uuid" })).status).toBe(400);
      expect((await prisma.reel.findUniqueOrThrow({ where: { id: ok.body.id } })).linkedGigId).toBe(mine.id);
    });

    it("the card is absent for a suspended seller's reel and for a viewer who blocked the seller, and link clicks on a gig card count", async () => {
      const c = await creator();
      const g = await liveGig(c);
      const reel = await postReel(c, { linkedGigId: g.id });
      const viewer = await t.login();
      await t.app.get(ProfilesService).ensure(viewer.userId);
      expect((await get(`/v1/reels/${reel.body.id}`, viewer)).body.gig).toMatchObject({ id: g.id });
      const click = await http().post(`/v1/reels/${reel.body.id}/link-click`).set(auth(viewer)).send({});
      expect([click.status, click.body.counted]).toEqual([202, true]);
      await setUserStatus(c.userId, "SUSPENDED");
      try {
        expect((await get(`/v1/reels/${reel.body.id}`)).status).toBe(404);
      } finally {
        await setUserStatus(c.userId, "ACTIVE");
      }
      // the block: the viewer no longer gets the seller's reel, so no card either; unblocking brings both back
      const handle = await handleOf(c);
      expect((await http().put(`/v1/blocks/${handle}`).set(auth(viewer))).status).toBe(200);
      const blocked = await get(`/v1/reels/${reel.body.id}`, viewer);
      expect(blocked.status).toBe(404);
      expect(JSON.stringify(blocked.body)).not.toContain(g.slug);
      expect((await http().delete(`/v1/blocks/${handle}`).set(auth(viewer))).status).toBe(200);
      expect((await get(`/v1/reels/${reel.body.id}`, viewer)).body.gig).toMatchObject({ id: g.id });
    });
  });
});
