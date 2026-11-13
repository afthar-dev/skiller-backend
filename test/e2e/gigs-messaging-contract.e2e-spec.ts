import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { MESSAGE_STREAM_OPTIONS } from "../../src/modules/messaging/message-stream.hub";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";
import { checkDeclared, problemsOf } from "../support/openapi-shape";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
type Person = Session & { handle: string };
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);

interface Doc {
  paths: Record<string, Record<string, { responses: Record<string, { description?: string; content?: Record<string, unknown> }> }>>;
  components: { schemas: Record<string, unknown> };
}
const openapi = () => JSON.parse(readFileSync(join(__dirname, "..", "..", "openapi.json"), "utf8")) as Doc;

// Every gig, studio gig, profile gigs and conversation response, checked against the schema in openapi.json; and the live stream read the way the web client reads it.
describe("typed responses: gigs, studio gigs, profile gigs and messaging", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let categoryId: string;
  let base: string;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  /** The response must have `status` and match the schema declared for `key`. */
  const declared = <T extends { status: number; body: unknown }>(res: T, key: string, status: number): T => {
    expect(res.status).toBe(status);
    return checkDeclared(res, key);
  };
  const get = (path: string, s?: Session) => {
    const req = http().get(path).set("X-Forwarded-For", uniqueIp());
    return s ? req.set(auth(s)) : req;
  };

  async function person(): Promise<Person> {
    const s = await t.login();
    const me = await http().get("/v1/me").set(auth(s));
    return { ...s, handle: me.body.profile.handle };
  }
  async function creator(): Promise<Person> {
    const s = await person();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    return s;
  }
  const asset = (ownerId: string, purpose: "THUMBNAIL" | "GIG_GALLERY") =>
    prisma.mediaAsset.create({ data: { ownerId, purpose, bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "image/png", declaredSize: 10n } });
  const pkg = (tier: string, price: string) => ({ tier, name: `${tier} pack`, description: "What you get", pricePaise: price, deliveryDays: 3, revisions: 2, features: ["one", "two"] });
  async function liveGig(seller: Session): Promise<string> {
    const cover = await asset(seller.userId, "THUMBNAIL");
    const res = await http().post("/v1/studio/gigs").set(auth(seller)).send({ title: `Gig ${uniq()}`, description: "d", categoryId, packages: [pkg("BASIC", "49900")], coverAssetId: cover.id });
    expect(res.status).toBe(201);
    expect((await http().post(`/v1/studio/gigs/${res.body.id}/activate`).set(auth(seller))).status).toBe(200);
    return res.body.id as string;
  }

  beforeAll(async () => {
    t = await createAuthTestApp({}, (b) => b.overrideProvider(MESSAGE_STREAM_OPTIONS).useValue({ heartbeatMs: 150 }));
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
    await t.app.listen(0, "127.0.0.1");
    base = (await t.app.getUrl()).replace("[::1]", "127.0.0.1");
  });
  afterAll(() => t?.close());

  it("studio gigs, the public catalog, a gig page and a profile's gigs", async () => {
    const seller = await creator();
    const cover = await asset(seller.userId, "THUMBNAIL");
    const picture = await asset(seller.userId, "GIG_GALLERY");
    const created = declared(
      await http()
        .post("/v1/studio/gigs")
        .set(auth(seller))
        .send({
          title: `Logo design ${uniq()}`,
          description: "I design logos.\nFast.",
          categoryId,
          tags: ["logo", "branding"],
          packages: [pkg("BASIC", "49900"), pkg("STANDARD", "99900"), pkg("PREMIUM", "199900")],
          faqs: [{ question: "Do you do revisions?", answer: "Yes." }],
          coverAssetId: cover.id,
          galleryAssetIds: [picture.id],
        }),
      "POST /v1/studio/gigs",
      201,
    );
    const id = created.body.id as string;
    expect(created.body.status).toBe("DRAFT");
    declared(await http().get("/v1/studio/gigs").set(auth(seller)), "GET /v1/studio/gigs", 200);
    declared(await http().get("/v1/studio/gigs?status=DRAFT").set(auth(seller)), "GET /v1/studio/gigs", 200);
    declared(await http().get(`/v1/studio/gigs/${id}`).set(auth(seller)), "GET /v1/studio/gigs/{id}", 200);
    declared(await http().patch(`/v1/studio/gigs/${id}`).set(auth(seller)).send({ tags: ["logo"], faqs: [] }), "PATCH /v1/studio/gigs/{id}", 200);

    const live = declared(await http().post(`/v1/studio/gigs/${id}/activate`).set(auth(seller)), "POST /v1/studio/gigs/{id}/activate", 200);
    expect(live.body.status).toBe("ACTIVE");
    const slug = live.body.slug as string;

    const page = declared(await get(`/v1/gigs/${slug}`), "GET /v1/gigs/{slug}", 200);
    expect(page.body.seller.handle).toBe(seller.handle);
    declared(await get(`/v1/gigs/${slug}`, await person()), "GET /v1/gigs/{slug}", 200);
    const catalog = declared(await get("/v1/gigs?sort=newest&limit=50"), "GET /v1/gigs", 200);
    expect(catalog.body.items.some((g: { id: string }) => g.id === id)).toBe(true);
    declared(await get("/v1/gigs?q=logo&category=development&minPrice=100&maxPrice=999999999"), "GET /v1/gigs", 200);
    declared(await get(`/v1/profiles/${seller.handle}/gigs`), "GET /v1/profiles/{handle}/gigs", 200);

    declared(await http().post(`/v1/studio/gigs/${id}/pause`).set(auth(seller)), "POST /v1/studio/gigs/{id}/pause", 200);
    expect((await http().delete(`/v1/studio/gigs/${id}`).set(auth(seller))).status).toBe(204);
  });

  it("conversations: start (new and existing), list, messages, send, read, unread count", async () => {
    const [seller, buyer] = [await creator(), await person()];
    const gigId = await liveGig(seller);

    const first = declared(await http().post("/v1/conversations").set(auth(buyer)).send({ recipientHandle: seller.handle, gigId, message: "Hello, are you free?" }), "POST /v1/conversations", 201);
    expect(first.body.conversation.gig).not.toBeNull();
    expect(first.body.conversation.paymentNotice).toEqual(expect.any(String));
    const id = first.body.conversation.id as string;
    declared(await http().post("/v1/conversations").set(auth(buyer)).send({ recipientHandle: seller.handle, message: "Again" }), "POST /v1/conversations", 200);

    // a plain conversation has no gig and no payment notice
    const plain = declared(await http().post("/v1/conversations").set(auth(seller)).send({ recipientHandle: (await person()).handle, message: "Hi" }), "POST /v1/conversations", 201);
    expect([plain.body.conversation.gig, plain.body.conversation.paymentNotice]).toEqual([null, null]);

    const sent = declared(await http().post(`/v1/conversations/${id}/messages`).set(auth(seller)).send({ body: "Yes, tell me more" }), "POST /v1/conversations/{id}/messages", 201);
    const listed = declared(await http().get("/v1/conversations").set(auth(buyer)), "GET /v1/conversations", 200);
    expect(listed.body.items[0]).toMatchObject({ id, archived: false });
    expect(listed.body.items[0].unreadCount).toBeGreaterThanOrEqual(1);
    declared(await http().get("/v1/conversations?archived=true").set(auth(buyer)), "GET /v1/conversations", 200);
    const msgs = declared(await http().get(`/v1/conversations/${id}/messages`).set(auth(buyer)), "GET /v1/conversations/{id}/messages", 200);
    expect(msgs.body.items[0].id).toBe(sent.body.id);
    declared(await http().get(`/v1/conversations/${id}/messages?after=${msgs.body.items[msgs.body.items.length - 1].id}`).set(auth(buyer)), "GET /v1/conversations/{id}/messages", 200);
    expect(declared(await http().get("/v1/conversations/unread-count").set(auth(buyer)), "GET /v1/conversations/unread-count", 200).body.count).toBeGreaterThanOrEqual(1);
    const read = declared(await http().post(`/v1/conversations/${id}/read`).set(auth(buyer)), "POST /v1/conversations/{id}/read", 200);
    expect(read.body).toEqual({ conversationId: id, unreadCount: 0 });
    expect((await http().post(`/v1/conversations/${id}/archive`).set(auth(buyer))).status).toBe(204);
    expect((await http().post(`/v1/conversations/${id}/unarchive`).set(auth(buyer))).status).toBe(204);

    // a hidden message keeps its place without its words, and still matches the schema (body null)
    await prisma.message.update({ where: { id: sent.body.id }, data: { status: "HIDDEN" } });
    const hidden = declared(await http().get(`/v1/conversations/${id}/messages`).set(auth(buyer)), "GET /v1/conversations/{id}/messages", 200);
    expect(hidden.body.items[0]).toMatchObject({ id: sent.body.id, status: "HIDDEN", body: null });
  });

  it("the stream is documented as text/event-stream with its three events", () => {
    const doc = openapi();
    const ok = doc.paths["/v1/conversations/stream"].get.responses["200"];
    expect(Object.keys(ok.content ?? {})).toEqual(["text/event-stream"]);
    for (const name of ["message", "expired", "revoked"]) expect(ok.description).toContain(`\`${name}\``);
    expect(doc.components.schemas.MessageStreamEvent).toBeDefined();
  });

  describe("live stream read with fetch and a bearer token", () => {
    /** Opens the stream like the web client: fetch, Authorization header, body read as text. */
    async function open(s?: { accessToken: string }) {
      const controller = new AbortController();
      const res = await fetch(`${base}/v1/conversations/stream`, { headers: { Accept: "text/event-stream", ...(s ? auth(s) : {}) }, signal: controller.signal });
      let text = "";
      let done = false;
      const pump = (async () => {
        if (!res.body || res.status !== 200) {
          done = true;
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            text += decoder.decode(chunk.value, { stream: true });
          }
        } catch {
          // aborted by the test
        } finally {
          done = true;
        }
      })();
      const until = async (cond: () => boolean, ms = 8000) => {
        const end = Date.now() + ms;
        while (!cond()) {
          if (Date.now() > end) throw new Error(`timed out waiting for the stream; so far: ${JSON.stringify(text)}`);
          await new Promise((r) => setTimeout(r, 25));
        }
      };
      return { res, text: () => text, ended: () => done, until, close: () => controller.abort(), pump };
    }

    it("sends a message event to the receiver when the other party sends, and its data matches the schema", async () => {
      const [a, b] = [await person(), await person()];
      const started = await http().post("/v1/conversations").set(auth(a)).send({ recipientHandle: b.handle, message: "first" });
      const id = started.body.conversation.id as string;
      const stream = await open(b);
      expect(stream.res.status).toBe(200);
      expect(stream.res.headers.get("content-type")).toMatch(/^text\/event-stream/);
      await stream.until(() => stream.text().includes(": connected"));
      const sent = await http().post(`/v1/conversations/${id}/messages`).set(auth(a)).send({ body: "live over fetch" });
      await stream.until(() => stream.text().includes("live over fetch"));
      const block = stream.text().split("\n\n").find((chunk) => chunk.includes("live over fetch"))!;
      expect(block).toMatch(/^event: message$/m);
      const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]);
      expect(data).toMatchObject({ conversationId: id, message: { id: sent.body.id, senderId: a.userId, body: "live over fetch" } });
      expect(problemsOf(data, { $ref: "#/components/schemas/MessageStreamEvent" } as never)).toEqual([]);
      stream.close();
      await stream.pump;
    });

    it("answers 401 without an Authorization header, and with a bad token", async () => {
      const none = await open();
      expect(none.res.status).toBe(401);
      expect(((await none.res.json()) as { error: { code: string } }).error.code).toEqual(expect.any(String));
      const bad = await open({ accessToken: "nope" });
      expect(bad.res.status).toBe(401);
      await bad.res.body?.cancel();
    });

    it("ends with a revoked event after sign-out", async () => {
      const b = await person();
      const stream = await open(b);
      expect(stream.res.status).toBe(200);
      await stream.until(() => stream.text().includes(": connected"));
      expect((await http().post("/v1/auth/logout").set(auth(b)).set("Cookie", b.cookie.raw)).status).toBeLessThan(300);
      await stream.until(() => stream.ended());
      expect(stream.text()).toMatch(/event: revoked\ndata: \{\}\n\n$/);
      await stream.pump;
    });
  });
});
