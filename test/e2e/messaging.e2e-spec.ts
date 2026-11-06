import { randomUUID } from "node:crypto";
import http from "node:http";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { UserStatusCache } from "../../src/modules/identity";
import { MESSAGE_STREAM_OPTIONS } from "../../src/modules/messaging/message-stream.hub";
import { ModerationTargetRegistry } from "../../src/modules/moderation";
import { RolesService } from "../../src/modules/rbac";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
type Person = Session & { handle: string };
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);

describe("messaging", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let categoryId: string;
  const api = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  async function person(): Promise<Person> {
    const s = await t.login();
    const me = await api().get("/v1/me").set(auth(s));
    return { ...s, handle: me.body.profile.handle };
  }
  const start = (from: Session, to: { handle: string }, message = "Hello there", extra: Record<string, unknown> = {}) =>
    api().post("/v1/conversations").set(auth(from)).send({ recipientHandle: to.handle, message, ...extra });
  const send = (from: Session, conversationId: string, body = "Another one") => api().post(`/v1/conversations/${conversationId}/messages`).set(auth(from)).send({ body });
  const messages = (as: Session, conversationId: string, qs = "") => api().get(`/v1/conversations/${conversationId}/messages${qs}`).set(auth(as));
  const list = (as: Session, qs = "") => api().get(`/v1/conversations${qs}`).set(auth(as));
  const unread = async (as: Session) => (await api().get("/v1/conversations/unread-count").set(auth(as))).body.count as number;
  const markRead = (as: Session, conversationId: string) => api().post(`/v1/conversations/${conversationId}/read`).set(auth(as));
  const setPolicy = (as: Session, allowMessagesFrom: string) => api().patch("/v1/me/profile").set(auth(as)).send({ allowMessagesFrom });
  const block = (me: Session, handle: string) => api().put(`/v1/blocks/${handle}`).set(auth(me));
  const unblock = (me: Session, handle: string) => api().delete(`/v1/blocks/${handle}`).set(auth(me));
  async function setStatus(userId: string, status: "ACTIVE" | "SUSPENDED") {
    await prisma.user.update({ where: { id: userId }, data: { status } });
    await t.app.get(UserStatusCache).bust(userId);
  }
  /** A conversation between two fresh people, started by `a`. */
  async function pair() {
    const [a, b] = [await person(), await person()];
    const res = await start(a, b, "first");
    expect(res.status).toBe(201);
    return { a, b, id: res.body.conversation.id as string };
  }
  const creator = async () => {
    const s = await person();
    expect((await api().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    return s;
  };
  async function liveGig(seller: Session) {
    const cover = await prisma.mediaAsset.create({ data: { ownerId: seller.userId, purpose: "THUMBNAIL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "image/png", declaredSize: 10n } });
    const created = await api()
      .post("/v1/studio/gigs")
      .set(auth(seller))
      .send({ title: `Gig ${uniq()}`, description: "I do things", categoryId, packages: [{ tier: "BASIC", name: "Basic", pricePaise: "49900", deliveryDays: 2, revisions: 1 }], coverAssetId: cover.id });
    expect(created.status).toBe(201);
    expect((await api().post(`/v1/studio/gigs/${created.body.id}/activate`).set(auth(seller))).status).toBe(200);
    return created.body as { id: string; slug: string };
  }

  beforeAll(async () => {
    t = await createAuthTestApp({}, (b) => b.overrideProvider(MESSAGE_STREAM_OPTIONS).useValue({ heartbeatMs: 150 }));
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  describe("privacy: conversations belong to their two participants", () => {
    it("a stranger gets 404 for reading, writing, marking read, archiving and reporting; the list never shows it", async () => {
      const { a, b, id } = await pair();
      const mallory = await person();
      const sent = await send(b, id, "private words");
      expect(sent.status).toBe(201);
      const probes = [
        await messages(mallory, id),
        await send(mallory, id, "let me in"),
        await markRead(mallory, id),
        await api().post(`/v1/conversations/${id}/archive`).set(auth(mallory)),
        await api().post(`/v1/conversations/${id}/unarchive`).set(auth(mallory)),
        await messages(mallory, randomUUID()), // an id that does not exist answers the same
      ];
      for (const res of probes) {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("CONVERSATION_NOT_FOUND");
      }
      // the same body whether the conversation exists or not: no existence oracle
      expect(probes[0].body.error.message).toBe(probes[5].body.error.message);
      expect((await list(mallory)).body.items).toEqual([]);
      expect(await unread(mallory)).toBe(0);
      const report = await api().post("/v1/reports").set(auth(mallory)).send({ targetType: "GIG_MESSAGE", targetId: sent.body.id, reason: "SPAM" });
      expect([report.status, report.body.error.code]).toEqual([404, "REPORT_TARGET_NOT_FOUND"]);
      // nothing leaked into the stranger's notifications either
      expect(await prisma.notification.count({ where: { userId: mallory.userId } })).toBe(0);
      // participants are unaffected
      expect((await messages(a, id)).body.items.map((m: { body: string }) => m.body)).toEqual(["private words", "first"]);
    });

    it("every route needs a signed-in user", async () => {
      const { id } = await pair();
      for (const [method, path] of [["get", "/v1/conversations"], ["get", `/v1/conversations/${id}/messages`], ["post", `/v1/conversations/${id}/messages`], ["post", `/v1/conversations/${id}/read`], ["post", "/v1/conversations"], ["get", "/v1/conversations/unread-count"], ["get", "/v1/conversations/stream"]] as const) {
        expect([path, (await api()[method](path)).status]).toEqual([path, 401]);
      }
    });
  });

  describe("starting a conversation", () => {
    it("get-or-create: the first call creates it (201), the second reuses it (200) with the new message appended; one conversation per pair either way round", async () => {
      const a = await person();
      const b = await person();
      const first = await start(a, b, "  hi\u0007 there  ");
      expect(first.status).toBe(201);
      expect(first.body.message).toMatchObject({ senderId: a.userId, body: "hi there", status: "VISIBLE" });
      expect(first.body.conversation).toMatchObject({ gigId: null, unreadCount: 0 });
      expect(first.body.conversation.counterpart).toMatchObject({ id: b.userId, handle: b.handle });
      const again = await start(a, b, "second");
      expect([again.status, again.body.conversation.id]).toEqual([200, first.body.conversation.id]);
      const back = await start(b, a, "from b");
      expect([back.status, back.body.conversation.id]).toEqual([200, first.body.conversation.id]);
      expect(await prisma.conversation.count({ where: { participants: { every: { userId: { in: [a.userId, b.userId] } } } } })).toBe(1);
      expect((await messages(a, first.body.conversation.id)).body.items.map((m: { body: string }) => m.body)).toEqual(["from b", "second", "hi there"]);
    });

    it("parallel starts between the same two people still make one conversation", async () => {
      const a = await person();
      const b = await person();
      const results = await Promise.all([start(a, b, "1"), start(b, a, "2"), start(a, b, "3"), start(b, a, "4")]);
      expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(new Set(results.map((r) => r.body.conversation.id)).size).toBe(1);
      expect(await prisma.message.count({ where: { conversationId: results[0].body.conversation.id } })).toBe(4);
    });

    it("refuses yourself, unknown people, empty or oversized text and unknown fields", async () => {
      const a = await person();
      const b = await person();
      const self = await start(a, a);
      expect([self.status, self.body.error.code]).toEqual([422, "MESSAGING_SELF"]);
      expect((await start(a, { handle: `nobody-${uniq()}` })).status).toBe(404);
      expect((await start(a, b, "   ")).status).toBe(400);
      expect((await start(a, b, "​\u0007")).status).toBe(400); // nothing left after cleaning
      expect((await start(a, b, "x".repeat(4001))).status).toBe(400);
      expect((await api().post("/v1/conversations").set(auth(a)).send({ recipientHandle: b.handle, message: "hi", sender: b.userId })).status).toBe(400);
      expect((await api().post("/v1/conversations").set(auth(a)).send({ message: "hi" })).status).toBe(400);
      const ok = await start(a, b, "x".repeat(4000));
      expect(ok.status).toBe(201);
      expect(ok.body.message.body).toHaveLength(4000);
    });

    it("message text is plain text: markup stays literal, line breaks survive, hidden characters go", async () => {
      const { a, id } = await pair();
      const res = await send(a, id, "<b>bold</b> <script>alert(1)</script>\r\nline two‮​");
      expect(res.status).toBe(201);
      expect(res.body.body).toBe("<b>bold</b> <script>alert(1)</script>\nline two");
    });

    it("allowMessagesFrom lives on the profile: EVERYONE by default, FOLLOWING (people they follow) and NONE stop strangers, with one and the same answer as a block", async () => {
      const a = await person();
      const target = await person();
      expect((await api().get("/v1/me").set(auth(target))).body.profile.allowMessagesFrom).toBe("EVERYONE");
      expect((await setPolicy(target, "SOMEONE")).status).toBe(400);
      expect((await setPolicy(target, "NONE")).body.allowMessagesFrom).toBe("NONE");
      const refused = await start(a, target);
      expect([refused.status, refused.body.error.code]).toEqual([403, "MESSAGING_NOT_ALLOWED"]);
      expect(await prisma.conversation.count({ where: { participants: { some: { userId: target.userId } } } })).toBe(0);

      await setPolicy(target, "FOLLOWING");
      expect((await start(a, target)).status).toBe(403); // the target does not follow a
      expect((await api().post(`/v1/profiles/${a.handle}/follow`).set(auth(target))).status).toBe(204);
      expect((await start(a, target)).status).toBe(201);
      // the setting is the owner's: nobody else can read it off a profile, which would tell a blocked sender apart from a closed inbox (I9)
      for (const viewer of [undefined, a, target]) {
        const res = await (viewer ? api().get(`/v1/profiles/${target.handle}`).set(auth(viewer)) : api().get(`/v1/profiles/${target.handle}`));
        expect(res.status).toBe(200);
        expect(res.body).not.toHaveProperty("allowMessagesFrom");
        expect(JSON.stringify(res.body)).not.toContain("allowMessagesFrom");
      }
      expect((await api().get("/v1/me").set(auth(target))).body.profile.allowMessagesFrom).toBe("FOLLOWING"); // the owner still sees it

      // blocked looks exactly like "not allowed": same status, code, message and details
      const blocker = await person();
      await block(blocker, a.handle);
      const blockedAnswer = await start(a, blocker);
      expect(blockedAnswer.status).toBe(403);
      expect(blockedAnswer.body.error).toEqual(refused.body.error);
    });

    it("blocks stop it both ways, and lifting the block lets it through again", async () => {
      const a = await person();
      const b = await person();
      await block(b, a.handle); // b blocked a
      for (const [from, to] of [[a, b], [b, a]] as const) expect([from.handle, (await start(from, to)).status]).toEqual([from.handle, 403]);
      expect((await unblock(b, a.handle)).status).toBeLessThan(300);
      expect((await start(a, b)).status).toBe(201);
    });

    it("suspended recipients and posting-restricted senders cannot start one", async () => {
      const a = await person();
      const b = await person();
      await setStatus(b.userId, "SUSPENDED");
      const gone = await start(a, b);
      expect([gone.status, gone.body.error.code]).toEqual([403, "MESSAGING_NOT_ALLOWED"]);
      await setStatus(b.userId, "ACTIVE");
      await prisma.userRestriction.upsert({ where: { userId: a.userId }, create: { userId: a.userId, until: new Date(t.clock.now().getTime() + 86400_000), reason: "test" }, update: { until: new Date(t.clock.now().getTime() + 86400_000) } });
      const barred = await start(a, b);
      expect([barred.status, barred.body.error.code]).toEqual([403, "POSTING_RESTRICTED"]);
      await prisma.userRestriction.delete({ where: { userId: a.userId } });
      expect((await start(a, b)).status).toBe(201);
    });
  });

  describe("gig inquiries", () => {
    it("a buyer starts a conversation from a live gig: it carries the gig and reaches a seller who takes no cold messages; blocks still apply", async () => {
      const seller = await creator();
      const gig = await liveGig(seller);
      await setPolicy(seller, "NONE");
      const buyer = await person();
      expect((await start(buyer, seller)).status).toBe(403); // from the profile: the setting holds
      const inquiry = await start(buyer, seller, "Can you do it by Friday?", { gigId: gig.id });
      expect(inquiry.status).toBe(201);
      expect(inquiry.body.conversation).toMatchObject({ gigId: gig.id });
      expect(inquiry.body.conversation.gig).toMatchObject({ id: gig.id, slug: gig.slug });
      expect(inquiry.body.conversation.paymentNotice).toMatch(/outside Skiller/i);
      const more = await send(buyer, inquiry.body.conversation.id, "And the price?");
      expect(more.status).toBe(201);

      const blocker = await person();
      await block(seller, blocker.handle);
      expect((await start(blocker, seller, "hi", { gigId: gig.id })).status).toBe(403);
    });

    it("the gig must be live and the seller must be the recipient", async () => {
      const seller = await creator();
      const other = await creator();
      const gig = await liveGig(seller);
      const buyer = await person();
      const wrongSeller = await start(buyer, other, "hi", { gigId: gig.id });
      expect([wrongSeller.status, wrongSeller.body.error.code]).toEqual([404, "GIG_NOT_FOUND"]);
      expect((await start(buyer, seller, "hi", { gigId: randomUUID() })).status).toBe(404);
      await api().post(`/v1/studio/gigs/${gig.id}/pause`).set(auth(seller));
      expect((await start(buyer, seller, "hi", { gigId: gig.id })).status).toBe(404);
      expect((await start(buyer, seller, "hi", { gigId: "not-a-uuid" })).status).toBe(400);
    });

    it("the gig card follows the gig: a paused or held-back gig, a suspended seller and a block in either direction drop the card while the conversation keeps working (I8)", async () => {
      const seller = await creator();
      const gig = await liveGig(seller);
      const buyer = await person();
      const inquiry = await start(buyer, seller, "about it", { gigId: gig.id });
      const id = inquiry.body.conversation.id as string;
      const cardFor = async (as: Session) => (await list(as)).body.items.find((c: { id: string }) => c.id === id)?.gig;
      const setGig = (status: "ACTIVE" | "PAUSED" | "HIDDEN" | "REMOVED") => prisma.gig.update({ where: { id: gig.id }, data: { status } });
      expect(await cardFor(buyer)).toMatchObject({ id: gig.id, slug: gig.slug });
      expect(await cardFor(seller)).toMatchObject({ id: gig.id });

      for (const status of ["PAUSED", "HIDDEN", "REMOVED"] as const) {
        await setGig(status);
        expect([status, await cardFor(buyer)]).toEqual([status, null]);
        expect([status, await cardFor(seller)]).toEqual([status, null]);
        expect((await messages(buyer, id)).status).toBe(200); // the conversation itself is untouched
        expect((await send(buyer, id, `still talking while ${status}`)).status).toBe(201);
      }
      await setGig("ACTIVE");
      expect(await cardFor(buyer)).toMatchObject({ id: gig.id });

      await setStatus(seller.userId, "SUSPENDED");
      try {
        expect(await cardFor(buyer)).toBeNull();
        expect((await messages(buyer, id)).status).toBe(200);
      } finally {
        await setStatus(seller.userId, "ACTIVE");
      }
      expect(await cardFor(buyer)).toMatchObject({ id: gig.id });

      await block(buyer, seller.handle);
      expect(await cardFor(buyer)).toBeNull();
      await unblock(buyer, seller.handle);
      await block(seller, buyer.handle);
      expect(await cardFor(buyer)).toBeNull();
      await unblock(seller, buyer.handle);
      expect(await cardFor(buyer)).toMatchObject({ id: gig.id });
      // the reply from the start call carries the same view
      expect((await start(buyer, seller, "again", { gigId: gig.id })).body.conversation.gig).toMatchObject({ id: gig.id });
    });

    it("a second inquiry about another gig reuses the pair's conversation and points it at the newest gig", async () => {
      const seller = await creator();
      const [g1, g2] = [await liveGig(seller), await liveGig(seller)];
      const buyer = await person();
      const first = await start(buyer, seller, "about the first", { gigId: g1.id });
      const second = await start(buyer, seller, "about the second", { gigId: g2.id });
      expect([second.status, second.body.conversation.id, second.body.conversation.gigId]).toEqual([200, first.body.conversation.id, g2.id]);
    });
  });

  describe("sending and reading", () => {
    it("messages list newest first with a signed cursor; a cursor from another conversation is refused; ?after= polls forward", async () => {
      const { a, b, id } = await pair();
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push((await send(i % 2 ? a : b, id, `m${i}`)).body.id);
      const p1 = await messages(a, id, "?limit=2");
      expect(p1.body.items.map((m: { body: string }) => m.body)).toEqual(["m3", "m2"]);
      expect(p1.body.nextCursor).toEqual(expect.any(String));
      const p2 = await messages(a, id, `?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
      expect(p2.body.items.map((m: { body: string }) => m.body)).toEqual(["m1", "m0"]);
      const p3 = await messages(a, id, `?limit=2&cursor=${encodeURIComponent(p2.body.nextCursor)}`);
      expect(p3.body.items.map((m: { body: string }) => m.body)).toEqual(["first"]);
      expect(p3.body.nextCursor).toBeNull();
      expect((await messages(a, id, "?cursor=garbage")).status).toBe(400);
      const other = await pair();
      const foreign = await messages(other.a, other.id, `?cursor=${encodeURIComponent(p1.body.nextCursor)}`);
      expect(foreign.status).toBe(400);
      // the polling fallback: everything after the last message I have, oldest first
      const since = await messages(b, id, `?after=${ids[1]}`);
      expect(since.body.items.map((m: { body: string }) => m.body)).toEqual(["m2", "m3"]);
      expect((await messages(b, id, `?after=${ids[3]}`)).body.items).toEqual([]);
    });

    it("unread counts come from lastReadAt: the other person's visible messages after it; reading resets; my own never count; a new message counts again", async () => {
      const { a, b, id } = await pair(); // a wrote "first"
      expect(await unread(b)).toBe(1);
      expect(await unread(a)).toBe(0);
      await send(a, id, "two");
      await send(a, id, "three");
      const row = (as: Session) => list(as).then((r) => r.body.items.find((c: { id: string }) => c.id === id));
      expect((await row(b)).unreadCount).toBe(3);
      expect((await row(a)).unreadCount).toBe(0);
      expect((await row(b)).lastMessage).toMatchObject({ body: "three", senderId: a.userId });
      const read = await markRead(b, id);
      expect([read.status, read.body.unreadCount]).toEqual([200, 0]);
      expect((await markRead(b, id)).status).toBe(200); // idempotent
      expect(await unread(b)).toBe(0);
      await send(b, id, "reply"); // sending does not mark the other side's messages read for a
      expect(await unread(a)).toBe(1);
      await send(a, id, "four"); // same instant on the test clock, still counted
      expect(await unread(b)).toBe(1);
      expect((await row(b)).unreadCount).toBe(1);
      const lastRead = (await prisma.conversationParticipant.findUniqueOrThrow({ where: { conversationId_userId: { conversationId: id, userId: b.userId } } })).lastReadAt;
      expect(lastRead).not.toBeNull();
      // the total spans conversations
      const c = await person();
      await start(c, b, "hello b");
      expect(await unread(b)).toBe(2);
    });

    it("the list orders by last activity with a cursor, shows the counterpart, and hides archived conversations until asked", async () => {
      const me = await person();
      const others = [await person(), await person(), await person()];
      const ids: string[] = [];
      for (const o of others) {
        ids.push((await start(me, o, `to ${o.handle}`)).body.conversation.id);
        t.clock.advanceSec(1);
      }
      await send(me, ids[0], "bump"); // the oldest one becomes the newest
      const p1 = await list(me, "?limit=2");
      expect(p1.body.items.map((c: { id: string }) => c.id)).toEqual([ids[0], ids[2]]);
      expect(p1.body.items[0].counterpart.id).toBe(others[0].userId);
      const p2 = await list(me, `?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
      expect(p2.body.items.map((c: { id: string }) => c.id)).toEqual([ids[1]]);
      expect(p2.body.nextCursor).toBeNull();
      expect((await list(me, "?cursor=garbage")).status).toBe(400);

      expect((await api().post(`/v1/conversations/${ids[2]}/archive`).set(auth(me))).status).toBe(204);
      expect((await list(me)).body.items.map((c: { id: string }) => c.id)).toEqual([ids[0], ids[1]]);
      expect((await list(me, "?archived=true")).body.items.map((c: { id: string }) => c.id)).toEqual([ids[2]]);
      expect((await list(others[2])).body.items).toHaveLength(1); // the other side is unaffected
      await send(others[2], ids[2], "you there?"); // a new message brings it back
      expect((await list(me)).body.items.map((c: { id: string }) => c.id)).toContain(ids[2]);
      expect((await api().post(`/v1/conversations/${ids[2]}/unarchive`).set(auth(me))).status).toBe(204);
    });

    it("blocking ends the conversation for writing, both ways, but each side can still read what was said; suspension of the other side too", async () => {
      const { a, b, id } = await pair();
      await send(b, id, "before the block");
      await block(a, b.handle);
      for (const who of [a, b]) {
        const res = await send(who, id, "after the block");
        expect([who.handle, res.status, res.body.error.code]).toEqual([who.handle, 403, "MESSAGING_NOT_ALLOWED"]);
      }
      expect((await messages(a, id)).body.items).toHaveLength(2);
      expect((await messages(b, id)).body.items).toHaveLength(2);
      await unblock(a, b.handle);
      expect((await send(b, id, "friends again")).status).toBe(201);
      await setStatus(b.userId, "SUSPENDED"); // a suspended account cannot even sign in; the other side can no longer write to it
      expect((await send(a, id, "hello?")).status).toBe(403);
      await setStatus(b.userId, "ACTIVE");
      expect((await send(a, id, "back")).status).toBe(201);
    });
  });

  describe("spam caps", () => {
    it("a person may start 20 conversations with new people a day; the 21st is refused, replies in old conversations are not counted", async () => {
      const spammer = await person();
      const targets = await Promise.all(Array.from({ length: 21 }, () => person()));
      const results: number[] = [];
      for (const target of targets) results.push((await start(spammer, target, "buy my thing")).status);
      expect(results.slice(0, 20).every((s) => s === 201)).toBe(true);
      expect(results[20]).toBe(429);
      const over = await start(spammer, targets[20], "please");
      expect(over.body.error).toMatchObject({ code: "RATE_LIMITED", details: { scope: "new_conversations_per_day" } });
      expect(over.body.error.details.retryAfterSec).toBeGreaterThan(0);
      expect(await prisma.conversation.count({ where: { participants: { some: { userId: targets[20].userId } } } })).toBe(0); // nothing was created
      // an existing contact is not "new": messaging them again still works
      expect((await start(spammer, targets[0], "again")).status).toBe(200);
      // and the cap is per sender
      const innocent = await person();
      expect((await start(innocent, targets[20], "hello")).status).toBe(201);
    });

    it("60 messages an hour per person, across all their conversations; the 61st is refused and nobody else is affected", async () => {
      const a = await person();
      const [b, c] = [await person(), await person()];
      const toB = (await start(a, b, "m0")).body.conversation.id;
      const toC = (await start(a, c, "m0")).body.conversation.id; // two messages so far
      let status = 0;
      for (let i = 2; i < 60; i++) status = (await send(a, i % 2 ? toB : toC, `m${i}`)).status;
      expect(status).toBe(201);
      const over = await send(a, toB, "one too many");
      expect([over.status, over.body.error.code, over.body.error.details.scope]).toEqual([429, "RATE_LIMITED", "messages_per_hour"]);
      expect((await send(b, toB, "b can still reply")).status).toBe(201);
      expect(await prisma.message.count({ where: { senderId: a.userId } })).toBe(60);
    }, 120_000);
  });

  describe("notifications", () => {
    it("the recipient hears about new messages, batched: one notification per conversation per window, never with the text, none for blocked or own messages", async () => {
      const { a, b, id } = await pair();
      const count = () => prisma.notification.count({ where: { userId: b.userId, type: "message.new" } });
      expect(await count()).toBe(1); // the first message
      await send(a, id, "second");
      await send(a, id, "third");
      expect(await count()).toBe(1); // still inside the window
      expect(await prisma.notification.count({ where: { userId: a.userId, type: "message.new" } })).toBe(0);
      const note = await prisma.notification.findFirstOrThrow({ where: { userId: b.userId, type: "message.new" } });
      expect(JSON.stringify(note)).not.toMatch(/first|second|third/);
      expect(note.data).toMatchObject({ conversationId: id });
      expect(note.link).toBe(`/messages/${id}`);
      // a reply notifies the other side once, independently
      await send(b, id, "reply");
      expect(await prisma.notification.count({ where: { userId: a.userId, type: "message.new" } })).toBe(1);
    });
  });

  describe("live stream (SSE)", () => {
    let base: string;
    beforeAll(async () => {
      await t.app.listen(0, "127.0.0.1");
      base = (await t.app.getUrl()).replace("[::1]", "127.0.0.1");
    });

    /** Opens the stream the way a client would and collects what arrives. */
    function open(s: { accessToken: string }, path = "/v1/conversations/stream") {
      return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: () => string; closed: () => boolean; close: () => void }>((resolve, reject) => {
        let buffer = "";
        let closed = false;
        const req = http.get(`${base}${path}`, { headers: { ...auth(s), Accept: "text/event-stream" } }, (res) => {
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (buffer += chunk));
          res.on("close", () => (closed = true));
          res.on("end", () => (closed = true));
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: () => buffer, closed: () => closed, close: () => req.destroy() });
        });
        req.on("error", (err) => (closed ? undefined : reject(err)));
      });
    }
    const until = async (cond: () => boolean, ms = 8000) => {
      const end = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > end) throw new Error("timed out waiting for the stream");
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    it("requires a valid token", async () => {
      const res = await open({ accessToken: "nope" });
      expect(res.status).toBe(401);
      res.close();
    });

    it("pushes new messages to both participants and to nobody else, with heartbeat comments in between", async () => {
      const { a, b, id } = await pair();
      const mallory = await person();
      const [sa, sb, sm] = await Promise.all([open(a), open(b), open(mallory)]);
      expect(sb.status).toBe(200);
      expect(sb.headers["content-type"]).toMatch(/text\/event-stream/);
      expect(sb.headers["cache-control"]).toMatch(/no-cache/);
      await until(() => sb.text().includes(": ping")); // 25 s in production, 150 ms here
      const sent = await send(a, id, "live hello");
      await until(() => sb.text().includes("live hello") && sa.text().includes("live hello"));
      const event = sb.text().split("\n\n").find((chunk) => chunk.includes("live hello"))!;
      expect(event).toMatch(/^event: message$/m);
      const data = JSON.parse(/^data: (.*)$/m.exec(event)![1]);
      expect(data).toMatchObject({ conversationId: id, message: { id: sent.body.id, senderId: a.userId, body: "live hello" } });
      await new Promise((r) => setTimeout(r, 400));
      expect(sm.text()).not.toContain("live hello"); // a stranger's stream stays silent
      expect(sm.text()).not.toContain(id);
      // the polling endpoints return the very same message without the stream
      expect((await messages(b, id)).body.items[0].id).toBe(sent.body.id);
      for (const s of [sa, sb, sm]) s.close();
    });

    it("closes when the session is revoked, and stops delivering after the client goes away", async () => {
      const { a, b, id } = await pair();
      const stream = await open(b);
      expect(stream.status).toBe(200);
      await api().post("/v1/auth/logout").set(auth(b)).set("Cookie", b.cookie.raw);
      await until(() => stream.closed());
      const gone = await open(a);
      gone.close();
      await send(a, id, "after the client left"); // must not throw on the server
      expect((await messages(a, id)).status).toBe(200);
    });

    it("closes when the access token expires", async () => {
      const { a } = await pair();
      const stream = await open(a);
      expect(stream.status).toBe(200);
      t.clock.advanceSec(16 * 60); // the access token lives 15 minutes
      await until(() => stream.closed());
      expect(stream.text()).toMatch(/event: expired/);
    });
  });

  describe("moderation: GIG_MESSAGE", () => {
    let moderator: Session;
    beforeAll(async () => {
      moderator = await t.login();
      await t.app.get(RolesService).grantSystem(moderator.userId, "moderator");
    });
    const report = (s: Session, targetId: string, reason = "HARASSMENT") => api().post("/v1/reports").set(auth(s)).send({ targetType: "GIG_MESSAGE", targetId, reason });
    const queue = () => api().get("/v1/admin/moderation/reports?type=GIG_MESSAGE").set(auth(moderator));

    it("only the other participant can report a message; the moderator sees the text of reported messages only; upholding removes it and strikes the sender", async () => {
      const { a, b, id } = await pair();
      const bad = (await send(a, id, "you are awful")).body.id as string;
      const fine = (await send(a, id, "see you tomorrow")).body.id as string;
      const own = await report(a, bad);
      expect([own.status, own.body.error.code]).toEqual([400, "REPORT_OWN_CONTENT"]);
      expect((await report(await person(), bad)).status).toBe(404);
      expect((await report(b, bad)).status).toBe(201);

      const q = await queue();
      const item = q.body.items.find((i: { targetId: string }) => i.targetId === bad);
      expect(item).toMatchObject({ targetType: "GIG_MESSAGE", ownerId: a.userId, reportCount: 1, preview: { text: "you are awful", status: "VISIBLE" } });
      expect(JSON.stringify(q.body)).not.toContain("see you tomorrow"); // unreported messages are never shown to moderators
      expect(JSON.stringify(q.body)).not.toContain(fine);

      const decision = await api().post(`/v1/admin/moderation/targets/GIG_MESSAGE/${bad}/uphold`).set(auth(moderator)).send({ note: "abusive" });
      expect(decision.status).toBe(200);
      expect(decision.body.strike).not.toBeNull();
      const seen = (await messages(b, id)).body.items.find((m: { id: string }) => m.id === bad);
      expect(seen).toMatchObject({ status: "REMOVED", body: null });
      expect((await messages(a, id)).body.items.find((m: { id: string }) => m.id === bad)).toMatchObject({ status: "REMOVED", body: null });
      expect(await unread(b)).toBe(2); // "first" and the fine one; the removed one no longer counts (it would be 3)
    });

    it("hide and restore work on the message (the report-threshold path), and a hidden message shows no text to anyone", async () => {
      const { a, b, id } = await pair();
      const sent = (await send(a, id, "borderline")).body.id as string;
      const target = t.app.get(ModerationTargetRegistry).get("GIG_MESSAGE")!;
      expect(await target.ownerOf(sent)).toBe(a.userId);
      expect(await prisma.$transaction((tx) => target.hide(tx, sent))).toBe(true);
      expect(await prisma.$transaction((tx) => target.hide(tx, sent))).toBe(false); // repeating is harmless
      for (const who of [a, b]) expect((await messages(who, id)).body.items.find((m: { id: string }) => m.id === sent)).toMatchObject({ status: "HIDDEN", body: null });
      expect(await prisma.$transaction((tx) => target.restore(tx, sent))).toBe(true);
      expect((await messages(b, id)).body.items.find((m: { id: string }) => m.id === sent)).toMatchObject({ status: "VISIBLE", body: "borderline" });
    });

    it("a dismissed report changes nothing", async () => {
      const { a, b, id } = await pair();
      const sent = (await send(a, id, "ordinary")).body.id as string;
      await report(b, sent);
      const dismissed = await api().post(`/v1/admin/moderation/targets/GIG_MESSAGE/${sent}/dismiss`).set(auth(moderator)).send({ note: "fine" });
      expect(dismissed.status).toBe(200);
      expect((await messages(b, id)).body.items.find((m: { id: string }) => m.id === sent)).toMatchObject({ status: "VISIBLE", body: "ordinary" });
    });
  });

});
