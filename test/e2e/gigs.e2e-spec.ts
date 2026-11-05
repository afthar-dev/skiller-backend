import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { EntitlementsService } from "../../src/modules/billing";
import { UserStatusCache } from "../../src/modules/identity";
import { givePlan } from "../support/billing";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);

describe("gig listings", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let categoryId: string;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const get = (path: string, s?: Session) => {
    const req = http().get(path).set("X-Forwarded-For", uniqueIp());
    return s ? req.set(auth(s)) : req;
  };

  const creator = async (plan?: string) => {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    if (plan) await givePlan(prisma, "USER", s.userId, plan);
    return s;
  };
  const pkg = (tier: string, over: Record<string, unknown> = {}) => ({ tier, name: `${tier} pack`, description: "What you get", pricePaise: "49900", deliveryDays: 3, revisions: 2, features: ["one", "two"], ...over });
  const body = (over: Record<string, unknown> = {}) => ({ title: `Logo design ${uniq()}`, description: "I design **logos**.", categoryId, tags: ["logo", "branding"], packages: [pkg("BASIC")], ...over });
  const create = (s: Session, over: Record<string, unknown> = {}) => http().post("/v1/studio/gigs").set(auth(s)).send(body(over));
  const asset = (ownerId: string, purpose: "THUMBNAIL" | "GIG_GALLERY" | "REEL" = "THUMBNAIL", over: Record<string, unknown> = {}) =>
    prisma.mediaAsset.create({ data: { ownerId, purpose, bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "image/png", declaredSize: 10n, ...over } });
  /** A gig ready to go live: description, BASIC package and a cover. */
  async function readyGig(s: Session, over: Record<string, unknown> = {}) {
    const cover = await asset(s.userId);
    const res = await create(s, { coverAssetId: cover.id, ...over });
    expect(res.status).toBe(201);
    return res.body as { id: string; slug: string; status: string };
  }
  const activate = (s: Session, id: string) => http().post(`/v1/studio/gigs/${id}/activate`).set(auth(s));
  async function setStatus(userId: string, status: "ACTIVE" | "SUSPENDED" | "DELETED") {
    await prisma.user.update({ where: { id: userId }, data: { status } });
    await t.app.get(UserStatusCache).bust(userId);
  }

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  describe("studio: create and edit", () => {
    it("a creator creates a draft with up to three packages and FAQs; money is a decimal string", async () => {
      const c = await creator();
      const res = await create(c, {
        title: "Logo design for startups",
        packages: [pkg("BASIC", { pricePaise: "9900" }), pkg("STANDARD", { pricePaise: "149900" }), pkg("PREMIUM", { pricePaise: "100000000" })],
        faqs: [{ question: "Do you do revisions?", answer: "Yes." }],
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ sellerId: c.userId, status: "DRAFT", categoryId, tags: ["logo", "branding"], coverAssetId: null, galleryAssetIds: [], publishedAt: null });
      expect(res.body.slug).toMatch(/^logo-design-for-startups(-\d+)?$/);
      expect(res.body.packages.map((p: { tier: string }) => p.tier)).toEqual(["BASIC", "STANDARD", "PREMIUM"]);
      expect(res.body.packages.map((p: { pricePaise: string }) => p.pricePaise)).toEqual(["9900", "149900", "100000000"]);
      expect(res.body.faqs).toEqual([{ question: "Do you do revisions?", answer: "Yes." }]);
      expect(res.body.paymentNotice).toMatch(/outside/i);

      const patch = await http().patch(`/v1/studio/gigs/${res.body.id}`).set(auth(c)).send({ tags: ["logo"], packages: [pkg("BASIC", { name: "Starter", pricePaise: "19900" })], faqs: [] });
      expect(patch.status).toBe(200);
      expect(patch.body.tags).toEqual(["logo"]);
      expect(patch.body.packages).toEqual([expect.objectContaining({ tier: "BASIC", name: "Starter", pricePaise: "19900" })]);
      expect(patch.body.faqs).toEqual([]);
      const list = await http().get("/v1/studio/gigs").set(auth(c));
      expect(list.body.items.map((g: { id: string }) => g.id)).toEqual([res.body.id]);
      expect((await http().get(`/v1/studio/gigs/${res.body.id}`).set(auth(c))).body.title).toBe("Logo design for startups");
    });

    it("only creators sell; strangers get 404 on someone else's gig", async () => {
      const member = await t.login();
      expect((await create(member)).status).toBe(403);
      const owner = await creator();
      const other = await creator();
      const gig = (await create(owner)).body;
      for (const res of [await http().get(`/v1/studio/gigs/${gig.id}`).set(auth(other)), await http().patch(`/v1/studio/gigs/${gig.id}`).set(auth(other)).send({ tags: ["x"] }), await activate(other, gig.id), await http().post(`/v1/studio/gigs/${gig.id}/pause`).set(auth(other)), await http().delete(`/v1/studio/gigs/${gig.id}`).set(auth(other))]) {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("GIG_NOT_FOUND");
      }
      expect((await http().get("/v1/studio/gigs").set(auth(other))).body.items).toEqual([]);
      expect((await http().get("/v1/studio/gigs")).status).toBe(401);
    });

    it("packages: BASIC is required, tiers are unique, at most three, prices stay between 99 and 1000000 rupees", async () => {
      const c = await creator();
      const bad = async (packages: unknown[]) => (await create(c, { packages })).status;
      expect(await bad([])).toBe(400);
      expect(await bad([pkg("STANDARD")])).toBe(400);
      expect(await bad([pkg("BASIC"), pkg("BASIC", { name: "again" })])).toBe(400);
      expect(await bad([pkg("BASIC"), pkg("STANDARD"), pkg("PREMIUM"), pkg("PREMIUM")])).toBe(400);
      expect(await bad([pkg("BASIC", { deliveryDays: 0 })])).toBe(400);
      expect(await bad([pkg("BASIC", { revisions: -1 })])).toBe(400);
      expect(await bad([pkg("BASIC", { pricePaise: 49900 })])).toBe(400); // a number, not a decimal string
      for (const price of ["0", "9899", "100000001", "99999999999"]) {
        const res = await create(c, { packages: [pkg("BASIC", { pricePaise: price })] });
        expect([price, res.status, res.body.error?.code]).toEqual([price, 422, "GIG_PRICE_INVALID"]);
      }
      const edge = await create(c, { packages: [pkg("BASIC", { pricePaise: "9900" }), pkg("PREMIUM", { pricePaise: "100000000" })] });
      expect(edge.status).toBe(201);
      // editing is held to the same rule, and nothing was half-saved
      const low = await http().patch(`/v1/studio/gigs/${edge.body.id}`).set(auth(c)).send({ packages: [pkg("BASIC", { pricePaise: "100" })] });
      expect([low.status, low.body.error.code]).toEqual([422, "GIG_PRICE_INVALID"]);
      expect((await http().get(`/v1/studio/gigs/${edge.body.id}`).set(auth(c))).body.packages).toHaveLength(2);
    });

    it("text is cleaned or refused: single-line title, unsafe Markdown, tag limits, unknown fields", async () => {
      const c = await creator();
      const ok = await create(c, { title: "  Logo\n design   ", tags: ["Logo", "logo", " BRAND "] });
      expect(ok.body.title).toBe("Logo design");
      expect(ok.body.tags).toEqual(["logo", "brand"]);
      const html = await create(c, { description: "hello <script>alert(1)</script>" });
      expect([html.status, html.body.error.code]).toEqual([422, "MARKDOWN_UNSAFE"]);
      expect((await create(c, { description: "[x](javascript:alert(1))" })).body.error.code).toBe("MARKDOWN_UNSAFE");
      expect((await create(c, { title: "ab" })).status).toBe(400);
      expect((await create(c, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).status).toBe(400);
      expect((await create(c, { status: "ACTIVE" })).status).toBe(400); // status is never client-set
      expect((await create(c, { sellerId: randomUUID() })).status).toBe(400);
      const cat = await create(c, { categoryId: randomUUID() });
      expect([cat.status, cat.body.error.code]).toEqual([422, "CATEGORY_INVALID"]);
    });

    it("slugs are unique and readable; a title with no ASCII still gets an address", async () => {
      const c = await creator();
      const title = `Poster design ${uniq()}`;
      const [a, b] = [(await create(c, { title })).body, (await create(c, { title })).body];
      expect(a.slug).not.toBe(b.slug);
      expect(b.slug.startsWith(a.slug)).toBe(true);
      const hindi = (await create(c, { title: "लोगो डिज़ाइन" })).body;
      expect(hindi.slug).toMatch(/^gig-[a-z0-9]+$/);
    });
  });

  describe("studio: media", () => {
    it("a cover (THUMBNAIL) and a gallery (GIG_GALLERY) attach to the gig and are released when replaced", async () => {
      const c = await creator();
      const gig = (await create(c)).body;
      const cover = await asset(c.userId, "THUMBNAIL");
      const [g1, g2, g3] = await Promise.all([asset(c.userId, "GIG_GALLERY"), asset(c.userId, "GIG_GALLERY"), asset(c.userId, "GIG_GALLERY")]);
      const res = await http().patch(`/v1/studio/gigs/${gig.id}`).set(auth(c)).send({ coverAssetId: cover.id, galleryAssetIds: [g2.id, g1.id] });
      expect(res.status).toBe(200);
      expect(res.body.coverAssetId).toBe(cover.id);
      expect(res.body.galleryAssetIds).toEqual([g2.id, g1.id]);
      for (const a of [cover, g1, g2]) expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: a.id } })).attachedAt).not.toBeNull();

      const swap = await http().patch(`/v1/studio/gigs/${gig.id}`).set(auth(c)).send({ galleryAssetIds: [g3.id, g2.id] });
      expect(swap.body.galleryAssetIds).toEqual([g3.id, g2.id]);
      const after = async (id: string) => prisma.mediaAsset.findUniqueOrThrow({ where: { id } });
      expect((await after(g1.id)).attachedAt).toBeNull(); // released
      expect((await after(g1.id)).detachedAt).not.toBeNull();
      expect((await after(g2.id)).attachedAt).not.toBeNull(); // kept, re-ordered
      expect((await after(g3.id)).attachedAt).not.toBeNull();

      const clear = await http().patch(`/v1/studio/gigs/${gig.id}`).set(auth(c)).send({ coverAssetId: null });
      expect(clear.body.coverAssetId).toBeNull();
      expect((await after(cover.id)).attachedAt).toBeNull();
    });

    it("someone else's asset, the wrong purpose, an unfinished upload, an asset in use and more than 10 pictures are refused", async () => {
      const c = await creator();
      const other = await creator();
      const gig = (await create(c)).body;
      const patch = (b: Record<string, unknown>) => http().patch(`/v1/studio/gigs/${gig.id}`).set(auth(c)).send(b);
      expect((await patch({ coverAssetId: (await asset(other.userId)).id })).status).toBe(422);
      expect((await patch({ coverAssetId: (await asset(c.userId, "REEL")).id })).status).toBe(422);
      expect((await patch({ coverAssetId: (await asset(c.userId, "THUMBNAIL", { status: "PROCESSING" })).id })).status).toBe(422);
      expect((await patch({ galleryAssetIds: [(await asset(c.userId, "THUMBNAIL")).id] })).status).toBe(422); // gallery wants GIG_GALLERY
      const org = await prisma.organization.create({ data: { slug: `org-${uniq()}`, name: "Org", ownerId: c.userId } });
      expect((await patch({ coverAssetId: (await asset(c.userId, "THUMBNAIL", { orgId: org.id })).id })).status).toBe(422); // an organization's upload
      const used = await asset(c.userId, "THUMBNAIL");
      expect((await patch({ coverAssetId: used.id })).status).toBe(200);
      const second = (await create(c)).body;
      const reuse = await http().patch(`/v1/studio/gigs/${second.id}`).set(auth(c)).send({ coverAssetId: used.id });
      expect(reuse.status).toBe(409);
      const many = await Promise.all(Array.from({ length: 11 }, () => asset(c.userId, "GIG_GALLERY")));
      expect((await patch({ galleryAssetIds: many.map((a) => a.id) })).status).toBe(400);
      expect((await patch({ galleryAssetIds: [many[0].id, many[0].id] })).status).toBe(400); // twice the same picture
      // a rejected change leaves the gig exactly as it was
      expect((await http().get(`/v1/studio/gigs/${gig.id}`).set(auth(c))).body.coverAssetId).toBe(used.id);
    });
  });

  describe("going live", () => {
    it("needs a description, a BASIC package and a cover; says what is missing", async () => {
      const c = await creator();
      const bare = (await create(c, { description: "" })).body;
      const res = await activate(c, bare.id);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("GIG_NOT_PUBLISHABLE");
      expect(res.body.error.details.reasons.map((r: { code: string }) => r.code).sort()).toEqual(["NO_COVER", "NO_DESCRIPTION"]);
      expect((await prisma.gig.findUniqueOrThrow({ where: { id: bare.id } })).status).toBe("DRAFT");
    });

    it("activate publishes, pause hides, activate again resumes; both are idempotent", async () => {
      const c = await creator();
      const gig = await readyGig(c);
      const live = await activate(c, gig.id);
      expect(live.status).toBe(200);
      expect(live.body).toMatchObject({ status: "ACTIVE" });
      const publishedAt = live.body.publishedAt;
      expect(publishedAt).not.toBeNull();
      expect((await activate(c, gig.id)).body.status).toBe("ACTIVE");
      expect((await get(`/v1/gigs/${gig.slug}`)).status).toBe(200);

      const paused = await http().post(`/v1/studio/gigs/${gig.id}/pause`).set(auth(c));
      expect([paused.status, paused.body.status]).toEqual([200, "PAUSED"]);
      expect((await http().post(`/v1/studio/gigs/${gig.id}/pause`).set(auth(c))).body.status).toBe("PAUSED");
      expect((await get(`/v1/gigs/${gig.slug}`)).status).toBe(404);

      const again = await activate(c, gig.id);
      expect([again.status, again.body.status, again.body.publishedAt]).toEqual([200, "ACTIVE", publishedAt]); // publishedAt is the first time
      // a draft cannot be paused
      const draft = (await create(c)).body;
      expect((await http().post(`/v1/studio/gigs/${draft.id}/pause`).set(auth(c))).status).toBe(409);
    });

    it("max_active_gigs: Free allows 5, a paused gig frees a slot, parallel activations never exceed the limit", async () => {
      const c = await creator("free");
      const gigs = [];
      for (let i = 0; i < 8; i++) gigs.push(await readyGig(c));
      const results = await Promise.all(gigs.map((g) => activate(c, g.id)));
      const ok = results.filter((r) => r.status === 200);
      const refused = results.filter((r) => r.status === 403);
      expect([ok.length, refused.length]).toEqual([5, 3]);
      expect(refused[0].body.error).toMatchObject({ code: "ENTITLEMENT_LIMIT_REACHED", details: { key: "max_active_gigs", limit: 5 } });
      expect(await prisma.gig.count({ where: { sellerId: c.userId, status: "ACTIVE" } })).toBe(5);

      const live = gigs.filter((_, i) => results[i].status === 200);
      const waiting = gigs.filter((_, i) => results[i].status !== 200);
      expect((await http().post(`/v1/studio/gigs/${live[0].id}/pause`).set(auth(c))).status).toBe(200);
      expect((await activate(c, waiting[0].id)).status).toBe(200);
      expect((await activate(c, waiting[1].id)).status).toBe(403);
      // re-activating one that is already live never counts it twice
      expect((await activate(c, live[1].id)).status).toBe(200);
    });

    it("the limit follows the plan: Pro 25, Business unlimited; plan versions stored before the key existed use their plan's default", async () => {
      const ent = t.app.get(EntitlementsService);
      const check = async (plan: string) => {
        const u = await creator(plan);
        return ent.limit({ ownerType: "USER", ownerId: u.userId }, "max_active_gigs");
      };
      expect(await check("free")).toBe(5);
      expect(await check("pro")).toBe(25);
      expect(await check("business")).toBeNull();
      expect(await check("org_starter")).toBeNull();
      // an old version's JSON has no such key: read with the default (here an unknown plan key, so the Free value; the per-key values are unit-tested)
      const { max_active_gigs: _gone, ...old } = (await prisma.planVersion.findFirstOrThrow({ where: { plan: { key: "pro" }, interval: "MONTH" } })).limits as Record<string, unknown>;
      const plan = await prisma.plan.create({ data: { key: `legacy_${uniq()}`, name: "Legacy", audience: "CREATOR" } });
      const legacy = await prisma.planVersion.create({ data: { planId: plan.id, pricePaise: 12345n, interval: "MONTH", commissionBps: 700, limits: old as never } });
      const u = await creator();
      await prisma.subscription.create({ data: { ownerType: "USER", ownerId: u.userId, planVersionId: legacy.id, status: "ACTIVE", razorpaySubscriptionId: `sub_${uniq()}`, currentPeriodEnd: new Date(Date.now() + 86400_000) } });
      expect(await ent.limit({ ownerType: "USER", ownerId: u.userId }, "max_active_gigs")).toBe(5);
    });

  });

  describe("public pages", () => {
    it("GET /v1/gigs/:slug shows only live gigs, with seller, packages, gallery, FAQs and the off-platform payment notice", async () => {
      const c = await creator();
      const g1 = await asset(c.userId, "GIG_GALLERY");
      const gig = await readyGig(c, { galleryAssetIds: [g1.id], faqs: [{ question: "Q?", answer: "A." }], packages: [pkg("BASIC"), pkg("STANDARD", { pricePaise: "99900" })] });
      expect((await get(`/v1/gigs/${gig.slug}`)).status).toBe(404); // draft
      await activate(c, gig.id);
      const res = await get(`/v1/gigs/${gig.slug}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: gig.id, slug: gig.slug, galleryAssetIds: [g1.id], faqs: [{ question: "Q?", answer: "A." }] });
      expect(res.body.packages.map((p: { tier: string; pricePaise: string }) => [p.tier, p.pricePaise])).toEqual([["BASIC", "49900"], ["STANDARD", "99900"]]);
      expect(res.body.paymentNotice).toMatch(/outside Skiller/i);
      expect(res.body.paymentNotice).toMatch(/not protected/i);
      const handle = (await prisma.profile.findUniqueOrThrow({ where: { userId: c.userId } })).handle;
      expect(res.body.seller).toMatchObject({ id: c.userId, handle });
      expect((await get("/v1/gigs/does-not-exist")).status).toBe(404);
    });

    it("hidden gigs never show: paused, deleted, moderated, and ones of a suspended or deleted seller", async () => {
      const c = await creator();
      const mk = async () => {
        const g = await readyGig(c);
        await activate(c, g.id);
        return g;
      };
      const [paused, deleted, hidden, removed, suspended] = [await mk(), await mk(), await mk(), await mk(), await mk()];
      await http().post(`/v1/studio/gigs/${paused.id}/pause`).set(auth(c));
      expect((await http().delete(`/v1/studio/gigs/${deleted.id}`).set(auth(c))).status).toBe(204);
      await prisma.gig.update({ where: { id: hidden.id }, data: { status: "HIDDEN" } });
      await prisma.gig.update({ where: { id: removed.id }, data: { status: "REMOVED" } });
      for (const g of [paused, deleted, hidden, removed]) expect([g.slug, (await get(`/v1/gigs/${g.slug}`)).status]).toEqual([g.slug, 404]);
      expect((await get(`/v1/gigs/${suspended.slug}`)).status).toBe(200);
      for (const status of ["SUSPENDED", "DELETED"] as const) {
        await setStatus(c.userId, status);
        expect([status, (await get(`/v1/gigs/${suspended.slug}`)).status]).toEqual([status, 404]);
      }
      await setStatus(c.userId, "ACTIVE");
      expect((await get(`/v1/gigs/${suspended.slug}`)).status).toBe(200);
    });

    it("a block hides the gig from the blocked viewer and from the seller's own blocker, both ways", async () => {
      const seller = await creator();
      const viewer = await t.login();
      const gig = await readyGig(seller);
      await activate(seller, gig.id);
      const handleOf = async (userId: string) => (await prisma.profile.findUniqueOrThrow({ where: { userId } })).handle;
      expect((await get(`/v1/gigs/${gig.slug}`, viewer)).status).toBe(200);
      await http().get("/v1/me").set(auth(viewer)); // profile exists
      expect((await http().put(`/v1/blocks/${await handleOf(seller.userId)}`).set(auth(viewer))).status).toBe(200);
      expect((await get(`/v1/gigs/${gig.slug}`, viewer)).status).toBe(404);
      expect((await get(`/v1/gigs/${gig.slug}`)).status).toBe(200); // anonymous
      await http().delete(`/v1/blocks/${await handleOf(seller.userId)}`).set(auth(viewer));
      expect((await http().put(`/v1/blocks/${await handleOf(viewer.userId)}`).set(auth(seller))).status).toBe(200);
      expect((await get(`/v1/gigs/${gig.slug}`, viewer)).status).toBe(404); // the seller blocked the viewer
    });

    it("GET /v1/profiles/:handle/gigs lists live gigs newest first with a cursor, nothing hidden, nothing for a blocked viewer", async () => {
      const seller = await creator();
      const handle = (await prisma.profile.findUniqueOrThrow({ where: { userId: seller.userId } })).handle;
      const live: string[] = [];
      for (let i = 0; i < 3; i++) {
        const g = await readyGig(seller);
        await activate(seller, g.id);
        live.push(g.id);
        t.clock.advanceSec(1);
      }
      const paused = await readyGig(seller);
      await activate(seller, paused.id);
      await http().post(`/v1/studio/gigs/${paused.id}/pause`).set(auth(seller));
      await readyGig(seller); // draft
      const first = await get(`/v1/profiles/${handle}/gigs?limit=2`);
      expect(first.status).toBe(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await get(`/v1/profiles/${handle}/gigs?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
      const ids = [...first.body.items, ...second.body.items].map((g: { id: string }) => g.id);
      expect(ids.sort()).toEqual([...live].sort());
      expect(second.body.nextCursor).toBeNull();
      expect(first.body.items[0]).toMatchObject({ slug: expect.any(String), title: expect.any(String), startingPricePaise: "49900", coverAssetId: expect.any(String) });
      expect(first.body.items[0]).not.toHaveProperty("description");
      expect((await get(`/v1/profiles/${handle}/gigs?cursor=garbage`)).status).toBe(400);
      expect((await get(`/v1/profiles/nobody-${uniq()}/gigs`)).status).toBe(404);

      const viewer = await t.login();
      await http().get("/v1/me").set(auth(viewer));
      await http().put(`/v1/blocks/${handle}`).set(auth(viewer));
      expect((await get(`/v1/profiles/${handle}/gigs`, viewer)).body.items).toEqual([]);
      await setStatus(seller.userId, "SUSPENDED");
      expect((await get(`/v1/profiles/${handle}/gigs`)).body.items).toEqual([]);
      await setStatus(seller.userId, "ACTIVE");
      expect((await get(`/v1/profiles/${handle}/gigs`)).body.items).toHaveLength(3);
    });

    it("public reads are rate limited per IP", async () => {
      const ip = uniqueIp();
      const statuses: number[] = [];
      for (let i = 0; i < 305; i++) statuses.push((await http().get("/v1/gigs/nope").set("X-Forwarded-For", ip)).status);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    }, 120_000);
  });

  describe("delete and the reserved order table", () => {
    it("deleting soft-deletes, keeps the address reserved, releases the pictures and drops it from the studio list", async () => {
      const c = await creator();
      const cover = await asset(c.userId);
      const pic = await asset(c.userId, "GIG_GALLERY");
      const gig = (await create(c, { coverAssetId: cover.id, galleryAssetIds: [pic.id] })).body;
      expect((await http().delete(`/v1/studio/gigs/${gig.id}`).set(auth(c))).status).toBe(204);
      expect((await http().delete(`/v1/studio/gigs/${gig.id}`).set(auth(c))).status).toBe(204); // twice is harmless
      const row = await prisma.gig.findUniqueOrThrow({ where: { id: gig.id } });
      expect(row.status).toBe("DELETED");
      for (const a of [cover, pic]) expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: a.id } })).attachedAt).toBeNull();
      expect((await http().get("/v1/studio/gigs").set(auth(c))).body.items).toEqual([]);
      expect((await http().get(`/v1/studio/gigs/${gig.id}`).set(auth(c))).status).toBe(404);
      expect((await http().patch(`/v1/studio/gigs/${gig.id}`).set(auth(c)).send({ tags: ["x"] })).status).toBe(404);
      expect((await activate(c, gig.id)).status).toBe(404);
      // the address is not handed to the next gig with the same title
      const again = (await create(c, { title: gig.title })).body;
      expect(again.slug).not.toBe(gig.slug);
    });

    it("moderated gigs cannot be edited, activated or paused by the seller", async () => {
      const c = await creator();
      for (const status of ["HIDDEN", "REMOVED"] as const) {
        const gig = await readyGig(c);
        await prisma.gig.update({ where: { id: gig.id }, data: { status } });
        expect((await http().patch(`/v1/studio/gigs/${gig.id}`).set(auth(c)).send({ tags: ["x"] })).status).toBe(409);
        expect((await activate(c, gig.id)).status).toBe(409);
        expect((await http().post(`/v1/studio/gigs/${gig.id}/pause`).set(auth(c))).status).toBe(409);
        expect((await http().get(`/v1/studio/gigs/${gig.id}`).set(auth(c))).body.status).toBe(status); // still visible to the seller, with its status
      }
    });

    it("gig_orders is reserved: the table exists, stays empty and no route serves it", async () => {
      expect(await prisma.gigOrder.count()).toBe(0);
      const c = await creator();
      for (const path of ["/v1/gig-orders", "/v1/studio/gig-orders", "/v1/gigs/orders"]) {
        const res = await http().get(path).set(auth(c));
        expect([path, res.status]).toEqual([path, 404]);
      }
    });
  });
});
