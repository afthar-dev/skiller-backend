import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import request from "supertest";
import { EventBus } from "../../src/common/outbox/event-bus";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { QueueNames, queueToken } from "../../src/common/queue/queue.constants";
import { NotificationEventHandlers } from "../../src/modules/notifications/notification-events.handler";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

describe("notifications", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let bus: EventBus;
  let mailQueue: Queue;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  /** Mail jobs for this address, any state (the in-process worker may already have completed them). */
  const mailJobs = async (to: string, template: string) =>
    (await mailQueue.getJobs(["waiting", "delayed", "active", "completed", "failed"])).filter((j) => j.data.to === to && j.data.template === template);
  const mediaReady = (ownerId: string) => ({ type: "media.ready" as const, assetId: randomUUID(), ownerId, purpose: "reel" });
  const mediaFailed = (ownerId: string) => ({ type: "media.failed" as const, assetId: randomUUID(), ownerId, reason: "DURATION_EXCEEDED", fileName: "holiday.mp4" });

  beforeAll(async () => {
    t = await createAuthTestApp({ providers: [NotificationEventHandlers] });
    prisma = t.app.get(PrismaService);
    bus = t.app.get(EventBus);
    mailQueue = t.app.get<Queue>(queueToken(QueueNames.mail));
  });
  afterAll(() => t?.close());

  it("requires authentication", async () => {
    expect((await http().get("/v1/notifications")).status).toBe(401);
    expect((await http().get("/v1/me/notification-preferences")).status).toBe(401);
  });

  it("media.ready creates exactly one notification for the owner, even when the event is delivered twice", async () => {
    const owner = await t.login();
    const other = await t.login();
    const event = mediaReady(owner.userId);
    const eventId = randomUUID();
    await bus.dispatch(event, eventId);
    await bus.dispatch(event, eventId); // at-least-once redelivery

    const list = await http().get("/v1/notifications").set(auth(owner));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ type: "media.ready", title: "Your video is ready", readAt: null, data: { assetId: event.assetId } });
    expect((await http().get("/v1/notifications").set(auth(other))).body.items).toHaveLength(0);

    // a different event for the same user is a different notification
    await bus.dispatch(mediaReady(owner.userId), randomUUID());
    expect((await http().get("/v1/notifications").set(auth(owner))).body.items).toHaveLength(2);
  });

  it("media.ready notifies only for videos (reel, course_lesson), not images or files", async () => {
    const u = await t.login();
    for (const purpose of ["avatar", "banner", "thumbnail", "gig_gallery", "course_resource"]) {
      await bus.dispatch({ type: "media.ready", assetId: randomUUID(), ownerId: u.userId, purpose }, randomUUID());
    }
    expect((await http().get("/v1/notifications").set(auth(u))).body.items).toHaveLength(0);
    await bus.dispatch({ type: "media.ready", assetId: randomUUID(), ownerId: u.userId, purpose: "course_lesson" }, randomUUID());
    await bus.dispatch(mediaReady(u.userId), randomUUID());
    expect((await http().get("/v1/notifications").set(auth(u))).body.items).toHaveLength(2);
  });

  it("unread count decrements on read; read-all clears the rest; unread filter and pagination work", async () => {
    const u = await t.login();
    for (let i = 0; i < 3; i++) await bus.dispatch(mediaReady(u.userId), randomUUID());
    expect((await http().get("/v1/notifications/unread-count").set(auth(u))).body).toEqual({ count: 3 });

    const page1 = await http().get("/v1/notifications?limit=2").set(auth(u));
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    const page2 = await http().get(`/v1/notifications?limit=2&cursor=${page1.body.nextCursor}`).set(auth(u));
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();

    const read = await http().post(`/v1/notifications/${page1.body.items[0].id}/read`).set(auth(u));
    expect(read.status).toBe(200);
    expect(read.body.readAt).toEqual(expect.any(String));
    expect((await http().get("/v1/notifications/unread-count").set(auth(u))).body).toEqual({ count: 2 });
    // idempotent
    expect((await http().post(`/v1/notifications/${page1.body.items[0].id}/read`).set(auth(u))).status).toBe(200);
    expect((await http().get("/v1/notifications/unread-count").set(auth(u))).body).toEqual({ count: 2 });
    expect((await http().get("/v1/notifications?unread=true").set(auth(u))).body.items).toHaveLength(2);

    const all = await http().post("/v1/notifications/read-all").set(auth(u));
    expect(all.body).toEqual({ updated: 2 });
    expect((await http().get("/v1/notifications/unread-count").set(auth(u))).body).toEqual({ count: 0 });
  });

  it("reading another user's notification is 404 NOTIFICATION_NOT_FOUND and leaves it unread", async () => {
    const owner = await t.login();
    const intruder = await t.login();
    await bus.dispatch(mediaReady(owner.userId), randomUUID());
    const id = (await http().get("/v1/notifications").set(auth(owner))).body.items[0].id;

    const res = await http().post(`/v1/notifications/${id}/read`).set(auth(intruder));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOTIFICATION_NOT_FOUND");
    expect((await http().post(`/v1/notifications/${randomUUID()}/read`).set(auth(intruder))).status).toBe(404);
    expect((await http().get("/v1/notifications/unread-count").set(auth(owner))).body).toEqual({ count: 1 });
  });

  it("media.failed creates an in-app row and one media_failed mail (deduplicated on redelivery)", async () => {
    const u = await t.login();
    const event = mediaFailed(u.userId);
    const eventId = randomUUID();
    await bus.dispatch(event, eventId);
    await bus.dispatch(event, eventId);

    expect((await http().get("/v1/notifications").set(auth(u))).body.items).toHaveLength(1);
    const jobs = await mailJobs(u.email, "media_failed");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data.data).toMatchObject({ fileName: "holiday.mp4", reason: expect.stringMatching(/longer than the maximum/) });
  });

  it("email preference off for media.failed: no mail job, in-app row still created; in-app off: mail but no row", async () => {
    const u = await t.login();
    const put = await http().put("/v1/me/notification-preferences").set(auth(u)).send({ items: [{ type: "media.failed", email: false }] });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ items: expect.any(Array) });
    expect(put.body.items.find((i: { type: string }) => i.type === "media.failed")).toEqual({ type: "media.failed", inApp: true, email: false });

    await bus.dispatch(mediaFailed(u.userId), randomUUID());
    expect((await http().get("/v1/notifications").set(auth(u))).body.items).toHaveLength(1);
    expect(await mailJobs(u.email, "media_failed")).toHaveLength(0);

    await http().put("/v1/me/notification-preferences").set(auth(u)).send({ items: [{ type: "media.failed", inApp: false, email: true }] });
    await bus.dispatch(mediaFailed(u.userId), randomUUID());
    expect((await http().get("/v1/notifications").set(auth(u))).body.items).toHaveLength(1); // unchanged
    expect(await mailJobs(u.email, "media_failed")).toHaveLength(1);
  });

  it("preference defaults: in-app on everywhere, email on only for transactional types; unknown types are rejected", async () => {
    const u = await t.login();
    const res = await http().get("/v1/me/notification-preferences").set(auth(u));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: expect.any(Array) });
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) expect(item).toEqual({ type: expect.any(String), inApp: expect.any(Boolean), email: expect.any(Boolean) });
    const byType = Object.fromEntries(res.body.items.map((i: { type: string; inApp: boolean; email: boolean }) => [i.type, i]));
    expect(byType["welcome"]).toMatchObject({ inApp: true, email: true });
    expect(byType["media.failed"]).toMatchObject({ inApp: true, email: true });
    expect(byType["media.ready"]).toMatchObject({ inApp: true, email: false });
    expect(byType["role.granted"]).toMatchObject({ inApp: true, email: false });

    const bad = await http().put("/v1/me/notification-preferences").set(auth(u)).send({ items: [{ type: "nope", email: true }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("user.registered: in-app welcome plus exactly one welcome mail; OTP mail is unaffected by preferences", async () => {
    const u = await t.login();
    await http().put("/v1/me/notification-preferences").set(auth(u)).send({ items: [{ type: "welcome", email: false, inApp: false }] });
    const before = t.mail.sent.length;
    // login another OTP while every welcome channel is off: the OTP still arrives
    await t.requestOtp(u.email);
    await t.codeFor(u.email, 1);
    expect(t.mail.sent.length).toBeGreaterThan(before);

    const fresh = await t.login();
    const eventId = randomUUID();
    const event = { type: "user.registered" as const, userId: fresh.userId, email: fresh.email };
    await bus.dispatch(event, eventId);
    await bus.dispatch(event, eventId);
    const items = (await http().get("/v1/notifications").set(auth(fresh))).body.items;
    expect(items.filter((i: { type: string }) => i.type === "welcome")).toHaveLength(1);
    expect(await mailJobs(fresh.email, "welcome")).toHaveLength(1);

    await bus.dispatch({ type: "user.registered", userId: u.userId, email: u.email }, randomUUID());
    expect(await mailJobs(u.email, "welcome")).toHaveLength(0);
    expect((await prisma.notification.count({ where: { userId: u.userId, type: "welcome" } }))).toBe(0);
  });

  it("role.granted notifies the grantee", async () => {
    const u = await t.login();
    await bus.dispatch({ type: "role.granted", userId: u.userId, roleKey: "moderator", grantedBy: randomUUID() }, randomUUID());
    const items = (await http().get("/v1/notifications").set(auth(u))).body.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "role.granted", data: { roleKey: "moderator" } });
  });
});
