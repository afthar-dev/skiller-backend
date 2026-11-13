import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { RolesService } from "../../src/modules/rbac";
import { givePlan } from "../support/billing";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);
const DAY = 24 * 3600_000;

describe("moderation: reports, decisions, strikes", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let moderator: Session;
  let categoryId: string;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  async function creator(plan = "business") {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    await givePlan(prisma, "USER", s.userId, plan);
    return s;
  }
  /** A reel posted through the API (published at once). */
  async function postReel(owner: Session, caption = `moderation #tag${uniq()}`) {
    const a = await prisma.mediaAsset.create({ data: { ownerId: owner.userId, purpose: "REEL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30 } });
    const res = await http().post("/v1/reels").set(auth(owner)).send({ mediaAssetId: a.id, caption });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PUBLISHED");
    return { id: res.body.id as string, assetId: a.id, hashtags: res.body.hashtags as string[] };
  }
  /** A published reel written straight to the database (for tests that need many). */
  async function rawReel(creatorId: string) {
    const a = await prisma.mediaAsset.create({ data: { ownerId: creatorId, purpose: "REEL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30, attachedAt: new Date() } });
    return prisma.reel.create({ data: { creatorId, mediaAssetId: a.id, caption: "", hashtags: [], status: "PUBLISHED", publishedAt: new Date() } });
  }
  const report = (s: Session, targetType: string, targetId: string, reason = "SPAM", extra: Record<string, unknown> = {}) =>
    http().post("/v1/reports").set(auth(s)).send({ targetType, targetId, reason, ...extra });
  const reporters = (n: number) => Promise.all(Array.from({ length: n }, () => t.login()));
  async function reportAll(users: Session[], targetType: string, targetId: string) {
    for (const u of users) expect([200, 201]).toContain((await report(u, targetType, targetId)).status);
  }
  const queue = (s: Session, qs = "") => http().get(`/v1/admin/moderation/reports${qs}`).set(auth(s));
  const uphold = (s: Session, type: string, id: string, note: unknown = "breaks the rules") => http().post(`/v1/admin/moderation/targets/${type}/${id}/uphold`).set(auth(s)).send({ note });
  const dismiss = (s: Session, type: string, id: string, note: unknown = "fine") => http().post(`/v1/admin/moderation/targets/${type}/${id}/dismiss`).set(auth(s)).send({ note });
  const reel = (id: string) => prisma.reel.findUniqueOrThrow({ where: { id } });
  const tagCount = async (tag: string) => (await prisma.hashtag.findUnique({ where: { tag } }))?.reelCount ?? 0;
  const notes = (userId: string, type: string) => prisma.notification.findMany({ where: { userId, type } });
  const comment = (s: Session, reelId: string, body: string) => http().post(`/v1/reels/${reelId}/comments`).set(auth(s)).send({ body });

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
    moderator = await t.login();
    await t.app.get(RolesService).grantSystem(moderator.userId, "moderator");
  });
  afterAll(() => t?.close());

  describe("reporting", () => {
    it("records one report per member per item: 201 first, 200 and the same report after; validates; not your own content", async () => {
      const owner = await creator();
      const { id } = await postReel(owner);
      const me = await t.login();
      const first = await report(me, "REEL", id, "SPAM", { note: "  looks like an ad  " });
      expect(first.status).toBe(201);
      const again = await report(me, "REEL", id, "HATE");
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      const rows = await prisma.report.findMany({ where: { targetType: "REEL", targetId: id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ reason: "SPAM", note: "looks like an ad", status: "OPEN", reporterId: me.userId });

      const own = await report(owner, "REEL", id);
      expect([own.status, own.body.error.code]).toEqual([400, "REPORT_OWN_CONTENT"]);
      for (const bad of [{ reason: "NOPE" }, { targetType: "USER" }, { note: "x".repeat(501) }, { extra: 1 }]) {
        expect((await http().post("/v1/reports").set(auth(me)).send({ targetType: "REEL", targetId: id, reason: "SPAM", ...bad })).status).toBe(400);
      }
      expect((await report(me, "REEL", randomUUID())).status).toBe(404);
      expect((await http().post("/v1/reports").send({ targetType: "REEL", targetId: id, reason: "SPAM" })).status).toBe(401);
    });

    it("allows 20 reports an hour per member", async () => {
      const owner = await creator();
      const me = await t.login();
      for (let i = 0; i < 20; i++) expect((await report(me, "REEL", (await rawReel(owner.userId)).id)).status).toBe(201);
      const over = await report(me, "REEL", (await rawReel(owner.userId)).id);
      expect([over.status, over.body.error.code]).toEqual([429, "RATE_LIMITED"]);
    });

    it("hides a reel when 5 distinct members reported it: gone for the public, still the owner's with its status; hashtag count drops; the owner hears once", async () => {
      const owner = await creator();
      const { id, hashtags } = await postReel(owner);
      const before = await tagCount(hashtags[0]);
      expect(before).toBeGreaterThan(0);
      const users = await reporters(6);
      await reportAll(users.slice(0, 4), "REEL", id);
      expect((await http().get(`/v1/reels/${id}`)).status).toBe(200);
      await reportAll(users.slice(4, 5), "REEL", id);
      expect((await http().get(`/v1/reels/${id}`)).status).toBe(404);
      const mine = await http().get(`/v1/reels/${id}`).set(auth(owner));
      expect([mine.status, mine.body.status]).toEqual([200, "HIDDEN"]);
      expect(await tagCount(hashtags[0])).toBe(before - 1);
      await reportAll(users.slice(5), "REEL", id); // a sixth report changes nothing more
      expect(await tagCount(hashtags[0])).toBe(before - 1);
      expect(await notes(owner.userId, "moderation.hidden")).toHaveLength(1);
      expect(await prisma.moderationHold.count({ where: { targetType: "REEL", targetId: id } })).toBe(1);
      expect((await prisma.auditLog.findMany({ where: { action: "moderation.autohide", targetId: id } })).length).toBe(1);
    });

    it("fires the auto-hide once when the 5th and 6th reports race", async () => {
      const owner = await creator();
      const { id, hashtags } = await postReel(owner);
      const before = await tagCount(hashtags[0]);
      const users = await reporters(7);
      await reportAll(users.slice(0, 4), "REEL", id);
      const results = await Promise.all(users.slice(4).map((u) => report(u, "REEL", id)));
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect((await reel(id)).status).toBe("HIDDEN");
      expect(await tagCount(hashtags[0])).toBe(before - 1);
      expect(await notes(owner.userId, "moderation.hidden")).toHaveLength(1);
    });
  });

  describe("decisions", () => {
    it("dismiss brings an auto-hidden reel back (status, hashtag count), closes the reports, gives no strike, and cannot be repeated", async () => {
      const owner = await creator();
      const { id, hashtags } = await postReel(owner);
      const before = await tagCount(hashtags[0]);
      await reportAll(await reporters(5), "REEL", id);
      expect((await reel(id)).status).toBe("HIDDEN");

      const res = await dismiss(moderator, "reel", id, "it is fine");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ decision: "DISMISSED", reports: 5, strike: null, restored: true });
      expect((await reel(id)).status).toBe("PUBLISHED");
      expect(await tagCount(hashtags[0])).toBe(before);
      expect((await http().get(`/v1/reels/${id}`)).status).toBe(200);
      const rows = await prisma.report.findMany({ where: { targetType: "REEL", targetId: id } });
      expect(rows.every((r) => r.status === "DISMISSED" && r.decidedBy === moderator.userId && r.decisionNote === "it is fine")).toBe(true);
      expect(await prisma.strike.count({ where: { userId: owner.userId } })).toBe(0);
      expect(await prisma.moderationHold.count({ where: { targetId: id } })).toBe(0);
      expect(await notes(owner.userId, "moderation.restored")).toHaveLength(1);
      expect((await prisma.auditLog.findMany({ where: { action: "moderation.dismiss", targetId: id } })).length).toBe(1);

      const twice = await dismiss(moderator, "reel", id);
      expect([twice.status, twice.body.error.code]).toEqual([409, "NO_OPEN_REPORTS"]);
    });

    it("dismiss of a reel that was never hidden leaves it as it is", async () => {
      const owner = await creator();
      const { id, hashtags } = await postReel(owner);
      const before = await tagCount(hashtags[0]);
      await reportAll(await reporters(2), "REEL", id);
      expect((await dismiss(moderator, "reel", id)).body).toMatchObject({ restored: false });
      expect((await reel(id)).status).toBe("PUBLISHED");
      expect(await tagCount(hashtags[0])).toBe(before);
    });

    it("uphold removes the reel once however many reported (hidden first, then removed: counts move once), frees the video, gives ONE strike and audits", async () => {
      const owner = await creator();
      const { id, hashtags, assetId } = await postReel(owner);
      const before = await tagCount(hashtags[0]);
      await reportAll(await reporters(5), "REEL", id);
      expect(await tagCount(hashtags[0])).toBe(before - 1);

      const res = await uphold(moderator, "REEL", id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ decision: "UPHELD", reports: 5, restrictedUntil: null });
      expect((await reel(id)).status).toBe("REMOVED");
      expect(await tagCount(hashtags[0])).toBe(before - 1);
      expect(await prisma.mediaAsset.findUnique({ where: { id: assetId } })).toBeNull(); // purged at once, not after the 24 h cleanup
      const strikes = await prisma.strike.findMany({ where: { userId: owner.userId } });
      expect(strikes).toHaveLength(1);
      expect(strikes[0].expiresAt.getTime() - strikes[0].createdAt.getTime()).toBe(90 * DAY);
      expect((await prisma.report.findMany({ where: { targetId: id } })).every((r) => r.status === "UPHELD")).toBe(true);
      expect(await notes(owner.userId, "moderation.strike")).toHaveLength(1);
      expect(await notes(owner.userId, "moderation.removed")).toHaveLength(1);
      const audit = await prisma.auditLog.findMany({ where: { action: "moderation.uphold", targetId: id } });
      expect(audit).toHaveLength(1);
      expect(audit[0].actorId).toBe(moderator.userId);

      expect((await http().get(`/v1/reels/${id}`)).status).toBe(404);
      const mine = await http().get(`/v1/reels/${id}`).set(auth(owner));
      expect([mine.status, mine.body.status]).toEqual([200, "REMOVED"]);
      expect((await uphold(moderator, "REEL", id)).status).toBe(409);
    });

    it("uphold of an unhidden reel with a single report still removes it and decrements the hashtag count once", async () => {
      const owner = await creator();
      const { id, hashtags } = await postReel(owner);
      const before = await tagCount(hashtags[0]);
      await reportAll(await reporters(1), "REEL", id);
      await uphold(moderator, "REEL", id);
      expect((await reel(id)).status).toBe("REMOVED");
      expect(await tagCount(hashtags[0])).toBe(before - 1);
    });

    it("needs moderation.review, and a moderator cannot decide on their own content", async () => {
      const owner = await creator();
      const { id } = await postReel(owner);
      await reportAll(await reporters(1), "REEL", id);
      const member = await t.login();
      for (const res of [await queue(member), await uphold(member, "REEL", id), await dismiss(member, "REEL", id)]) expect(res.status).toBe(403);
      expect((await http().get("/v1/admin/moderation/reports")).status).toBe(401);

      const modCreator = await creator();
      await t.app.get(RolesService).grantSystem(modCreator.userId, "moderator");
      const own = await postReel(modCreator);
      await reportAll(await reporters(1), "REEL", own.id);
      for (const res of [await uphold(modCreator, "REEL", own.id), await dismiss(modCreator, "REEL", own.id)]) expect([res.status, res.body.error.code]).toEqual([403, "MODERATION_SELF"]);
      expect((await reel(own.id)).status).toBe("PUBLISHED");
      expect((await uphold(moderator, "REEL", own.id, "")).status).toBe(400);
      expect((await uphold(moderator, "NOT_A_TYPE", own.id)).status).toBe(400);
    });

    it("lists open reports grouped by content, longest waiting first, with reasons and the hold flag; paginates and filters by type", async () => {
      const owner = await creator();
      const a = await postReel(owner);
      const b = await postReel(owner);
      const [r1, r2, r3, r4, r5] = await reporters(5);
      await report(r1, "REEL", a.id, "SPAM");
      await report(r2, "REEL", a.id, "SPAM");
      await report(r3, "REEL", a.id, "HATE");
      await report(r1, "REEL", b.id, "VIOLENCE");
      await reportAll([r2, r3, r4, r5], "REEL", b.id);

      const all: Array<Record<string, unknown>> = [];
      let cursor: string | null = null;
      do {
        const res = await queue(moderator, `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        expect(res.status).toBe(200);
        expect(res.body.items.length).toBeLessThanOrEqual(1);
        all.push(...res.body.items);
        cursor = res.body.nextCursor;
      } while (cursor);
      const ids = all.map((i) => i.targetId);
      expect(new Set(ids).size).toBe(ids.length);
      const ours = all.filter((i) => i.targetId === a.id || i.targetId === b.id);
      expect(ours.map((i) => i.targetId)).toEqual([a.id, b.id]);
      expect(ours[0]).toMatchObject({ targetType: "REEL", ownerId: owner.userId, reportCount: 3, reasons: { SPAM: 2, HATE: 1 }, autoHidden: false });
      expect(ours[1]).toMatchObject({ reportCount: 5, autoHidden: true, preview: { status: "HIDDEN" } });
      expect((await queue(moderator, "?type=reel_comment&limit=100")).body.items.every((i: { targetType: string }) => i.targetType === "REEL_COMMENT")).toBe(true);
      expect((await queue(moderator, "?type=bogus")).status).toBe(400);
      expect((await queue(moderator, "?cursor=garbage")).status).toBe(400);
    });
  });

  describe("comments", () => {
    it("auto-hides a comment at 5 reporters, keeps commentCount equal to the visible comments through hide, restore and removal, and drops it from the thread", async () => {
      const owner = await creator();
      const { id: reelId } = await postReel(owner);
      const author = await t.login();
      const other = await t.login();
      const c1 = (await comment(author, reelId, "spammy comment")).body.id as string;
      const c2 = (await comment(other, reelId, "nice reel")).body.id as string;
      expect((await reel(reelId)).commentCount).toBe(2);

      await reportAll(await reporters(5), "REEL_COMMENT", c1);
      expect((await prisma.reelComment.findUniqueOrThrow({ where: { id: c1 } })).status).toBe("HIDDEN");
      expect((await reel(reelId)).commentCount).toBe(1);
      const thread = await http().get(`/v1/reels/${reelId}/comments`);
      expect(thread.body.items.map((c: { id: string }) => c.id)).toEqual([c2]);

      expect((await dismiss(moderator, "reel_comment", c1)).body).toMatchObject({ restored: true });
      expect((await reel(reelId)).commentCount).toBe(2);
      expect((await http().get(`/v1/reels/${reelId}/comments`)).body.items.map((c: { id: string }) => c.id).sort()).toEqual([c1, c2].sort());

      await reportAll(await reporters(1), "REEL_COMMENT", c2);
      expect((await uphold(moderator, "REEL_COMMENT", c2)).status).toBe(200);
      expect((await prisma.reelComment.findUniqueOrThrow({ where: { id: c2 } })).status).toBe("REMOVED");
      expect((await reel(reelId)).commentCount).toBe(1);
      expect(await prisma.strike.count({ where: { userId: other.userId } })).toBe(1);
      // Removing a comment that was hidden first moves the count once.
      await reportAll(await reporters(5), "REEL_COMMENT", c1);
      expect((await reel(reelId)).commentCount).toBe(0);
      await uphold(moderator, "REEL_COMMENT", c1);
      expect((await reel(reelId)).commentCount).toBe(0);
      expect(await prisma.reelComment.count({ where: { reelId, status: "VISIBLE" } })).toBe(0);
    });
  });

  describe("course reviews and Q&A", () => {
    async function course(owner: Session) {
      const res = await http().post("/v1/studio/courses").set(auth(owner)).send({ title: `Reported ${uniq()}`, description: "A course", categoryId, language: "en", pricePaise: "0" });
      expect(res.status).toBe(201);
      const c = res.body as { id: string; slug: string };
      const section = await prisma.courseSection.create({ data: { courseId: c.id, title: "S", position: 0 } });
      const lesson = await prisma.lesson.create({ data: { courseId: c.id, sectionId: section.id, title: "Members", type: "ARTICLE", position: 0, articleBody: "t" } });
      await prisma.course.update({ where: { id: c.id }, data: { status: "PUBLISHED", publishedAt: new Date(), slugLockedAt: new Date() } });
      return { ...c, lessonId: lesson.id };
    }
    async function learner(c: { slug: string }) {
      const s = await t.login();
      expect((await http().post(`/v1/courses/${c.slug}/enrol`).set(auth(s))).status).toBe(201);
      return s;
    }
    const review = (s: Session, slug: string, body: Record<string, unknown>) => http().put(`/v1/courses/${slug}/reviews/mine`).set(auth(s)).send(body);

    it("reports on reviews hide them at 5 reporters through the Phase 3 hide (rating recomputed); dismiss restores; uphold keeps it hidden and strikes the reviewer", async () => {
      const author = await creator();
      const c = await course(author);
      const learners = await Promise.all(Array.from({ length: 3 }, () => learner(c)));
      const ids: string[] = [];
      for (const [i, l] of learners.entries()) ids.push((await review(l, c.slug, { rating: 5 - i, body: `review ${i}` })).body.id);
      expect((await prisma.course.findUniqueOrThrow({ where: { id: c.id } })).ratingCount).toBe(3);

      await reportAll(await reporters(5), "COURSE_REVIEW", ids[0]);
      const hidden = await prisma.review.findUniqueOrThrow({ where: { id: ids[0] } });
      expect(hidden.hiddenAt).not.toBeNull();
      expect((await prisma.course.findUniqueOrThrow({ where: { id: c.id } })).ratingCount).toBe(2);
      expect((await http().get(`/v1/courses/${c.slug}/reviews`)).body.items.map((r: { id: string }) => r.id)).not.toContain(ids[0]);

      expect((await dismiss(moderator, "course_review", ids[0])).body).toMatchObject({ restored: true });
      expect((await prisma.review.findUniqueOrThrow({ where: { id: ids[0] } })).hiddenAt).toBeNull();
      expect((await prisma.course.findUniqueOrThrow({ where: { id: c.id } })).ratingCount).toBe(3);

      await reportAll(await reporters(1), "COURSE_REVIEW", ids[1]);
      expect((await uphold(moderator, "COURSE_REVIEW", ids[1])).status).toBe(200);
      expect((await prisma.review.findUniqueOrThrow({ where: { id: ids[1] } })).hiddenAt).not.toBeNull();
      expect((await prisma.course.findUniqueOrThrow({ where: { id: c.id } })).ratingCount).toBe(2);
      expect(await prisma.strike.count({ where: { userId: learners[1].userId } })).toBe(1);
      // The course's own audit trail records the hide.
      expect(await prisma.auditLog.count({ where: { action: "course.review.hide", targetId: ids[1] } })).toBe(1);
    });

    it("reports on a question and an answer hide them; a moderator who authors the course cannot decide (MODERATION_SELF)", async () => {
      const author = await creator();
      await t.app.get(RolesService).grantSystem(author.userId, "moderator");
      const c = await course(author);
      const me = await learner(c);
      const q = (await http().post(`/v1/learn/lessons/${c.lessonId}/questions`).set(auth(me)).send({ body: "Q?" })).body.id as string;
      const answerer = await learner(c);
      const a = (await http().post(`/v1/learn/questions/${q}/answers`).set(auth(answerer)).send({ body: "A!" })).body.id as string;

      await reportAll(await reporters(5), "COURSE_QA", q);
      expect((await prisma.question.findUniqueOrThrow({ where: { id: q } })).hiddenAt).not.toBeNull();
      await reportAll(await reporters(1), "COURSE_QA", a);

      // The queue says which of the two each row is, so a moderator can hide or show it with the right call; other kinds of content carry none.
      const rows = (await queue(moderator, "?type=course_qa&limit=100")).body.items as { targetId: string; targetKind: string | null }[];
      expect(rows.find((r) => r.targetId === q)?.targetKind).toBe("QUESTION");
      expect(rows.find((r) => r.targetId === a)?.targetKind).toBe("ANSWER");
      expect((await queue(moderator, "?type=reel&limit=100")).body.items.every((i: { targetKind: unknown }) => i.targetKind === null)).toBe(true);

      for (const res of [await uphold(author, "COURSE_QA", q), await dismiss(author, "COURSE_QA", a)]) expect([res.status, res.body.error.code]).toEqual([403, "MODERATION_SELF"]);
      expect((await prisma.question.findUniqueOrThrow({ where: { id: q } })).hiddenAt).not.toBeNull();

      expect((await dismiss(moderator, "COURSE_QA", q)).body).toMatchObject({ restored: true });
      expect((await prisma.question.findUniqueOrThrow({ where: { id: q } })).hiddenAt).toBeNull();
      expect((await uphold(moderator, "COURSE_QA", a)).status).toBe(200);
      expect((await prisma.answer.findUniqueOrThrow({ where: { id: a } })).hiddenAt).not.toBeNull();
    });
  });

  // Last: it moves the shared fake clock by months, which expires everybody else's access tokens.
  describe("strikes and the posting ban", () => {
    it("bars posting for 7 days from the 3rd active strike (reels, publishing and comments, 403 POSTING_RESTRICTED with until); strikes expire after 90 days", async () => {
      const offender = await creator();
      const target = await creator();
      const reels = [];
      for (let i = 0; i < 3; i++) reels.push(await postReel(offender));
      const spare = await postReel(target);
      const results = [];
      for (const r of reels) {
        await reportAll(await reporters(1), "REEL", r.id);
        results.push((await uphold(moderator, "REEL", r.id)).body);
      }
      expect(results.map((r) => r.restrictedUntil)).toEqual([null, null, new Date(t.clock.now().getTime() + 7 * DAY).toISOString()]);
      expect(await prisma.strike.count({ where: { userId: offender.userId } })).toBe(3);
      expect(await notes(offender.userId, "moderation.restricted")).toHaveLength(1);

      const asset = await prisma.mediaAsset.create({ data: { ownerId: offender.userId, purpose: "REEL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30 } });
      const blocked = await http().post("/v1/reels").set(auth(offender)).send({ mediaAssetId: asset.id, caption: "again" });
      expect([blocked.status, blocked.body.error.code, blocked.body.error.details.until]).toEqual([403, "POSTING_RESTRICTED", results[2].restrictedUntil]);
      const noComment = await comment(offender, spare.id, "hello");
      expect([noComment.status, noComment.body.error.code]).toEqual([403, "POSTING_RESTRICTED"]);
      expect((await http().post(`/v1/reels/${randomUUID()}/publish`).set(auth(offender))).body.error.code).toBe("POSTING_RESTRICTED");
      // Reading and other members' posting are untouched.
      expect((await comment(target, spare.id, "still fine")).status).toBe(201);

      t.clock.advance(7 * DAY - 60_000);
      const again = await t.login(offender.email); // the access token only lives minutes on the fake clock
      expect((await comment(again, spare.id, "not yet")).status).toBe(403);
      t.clock.advance(120_000);
      const back = await t.login(offender.email);
      expect((await comment(back, spare.id, "back")).status).toBe(201);
      expect((await http().post("/v1/reels").set(auth(back)).send({ mediaAssetId: asset.id, caption: "again" })).status).toBe(201);

      // 90 days after the first strikes they no longer count: one fresh strike is strike number one, not a ban.
      t.clock.advance(91 * DAY);
      const later = await t.login(offender.email);
      const mod = await t.login(moderator.email);
      const fresh = await postReel(later);
      await reportAll(await reporters(1), "REEL", fresh.id);
      expect((await uphold(mod, "REEL", fresh.id)).body.restrictedUntil).toBeNull();
      expect((await comment(later, spare.id, "free again")).status).toBe(201);
    });
  });
});
