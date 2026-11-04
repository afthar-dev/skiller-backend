import request from "supertest";
import { EventBus } from "../../src/common/outbox/event-bus";
import type { DomainEvent } from "../../src/common/outbox/events";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { EnrolmentsService } from "../../src/modules/courses";
import { OrganizationDirectory } from "../../src/modules/organizations";
import { ProfilesService } from "../../src/modules/users";
import { CertificatesService } from "../../src/modules/courses/certificates.service";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

const NEVER = "3333333333"; // a well-formed code nobody holds

describe("course certificates", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let bus: EventBus;
  let categoryId: string;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const uniq = () => Math.random().toString(36).slice(2, 10);

  const creator = async () => {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    return s;
  };
  /** A published free course with one article lesson. */
  async function course(owner: Session) {
    const res = await http().post("/v1/studio/courses").set(auth(owner)).send({ title: `Certified ${uniq()}`, description: "A course", categoryId, language: "en", pricePaise: "0" });
    expect(res.status).toBe(201);
    const c = res.body as { id: string; slug: string; title: string };
    const section = await prisma.courseSection.create({ data: { courseId: c.id, title: "S", position: 0 } });
    const lesson = await prisma.lesson.create({ data: { courseId: c.id, sectionId: section.id, title: "Read", type: "ARTICLE", position: 0, articleBody: "text" } });
    await prisma.course.update({ where: { id: c.id }, data: { status: "PUBLISHED", publishedAt: new Date(), slugLockedAt: new Date() } });
    return { ...c, lessonId: lesson.id };
  }
  /** A learner who enrols and finishes the course; the course.completed event is not yet delivered. */
  async function finisher(c: { slug: string; lessonId: string; id: string }, name: string | null = "Asha Verma") {
    const s = await t.login();
    if (name !== null) {
      await t.app.get(ProfilesService).ensure(s.userId);
      await prisma.profile.update({ where: { userId: s.userId }, data: { displayName: name } });
    }
    expect((await http().post(`/v1/courses/${c.slug}/enrol`).set(auth(s))).status).toBe(201);
    expect((await http().post(`/v1/learn/lessons/${c.lessonId}/complete`).set(auth(s))).status).toBe(200);
    return s;
  }
  const completedRows = (userId: string, courseId: string) =>
    prisma.outboxEvent.findMany({ where: { type: "course.completed", AND: [{ payload: { path: ["userId"], equals: userId } }, { payload: { path: ["courseId"], equals: courseId } }] }, orderBy: { createdAt: "asc" } });
  /** Delivers the (latest) course.completed event the way the relay does. */
  async function deliverCompleted(userId: string, courseId: string, times = 1) {
    const rows = await completedRows(userId, courseId);
    const row = rows[rows.length - 1];
    for (let i = 0; i < times; i++) await bus.dispatch({ type: "course.completed", ...(row.payload as object) } as DomainEvent, row.id);
    return row;
  }
  const certs = (userId: string, courseId: string) => prisma.certificate.findMany({ where: { userId, courseId }, orderBy: { issuedAt: "asc" } });
  const verify = (code: string, ip = uniqueIp()) => http().get(`/v1/certificates/${code}`).set("X-Forwarded-For", ip);

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    bus = t.app.get(EventBus);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  describe("issuing", () => {
    it("completion issues exactly one certificate, however often the event is delivered", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await finisher(c);
      await deliverCompleted(me.userId, c.id, 3);
      const list = await certs(me.userId, c.id);
      expect(list).toHaveLength(1);
      const cert = list[0];
      expect(cert.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/);
      expect(cert.objectKey).toBe(`certificates/${cert.id}.pdf`);
      expect(cert.revokedAt).toBeNull();
      expect(cert.issuedAt.toISOString()).toBe(t.clock.now().toISOString());
      const profile = await prisma.profile.findUniqueOrThrow({ where: { userId: me.userId } });
      const ownerProfile = await prisma.profile.findUniqueOrThrow({ where: { userId: owner.userId } });
      expect(cert).toMatchObject({ learnerName: profile.displayName, courseTitle: c.title, issuerName: ownerProfile.displayName });
    });

    it("stores a PDF in private storage that only the owner can fetch, with the learner's name in it", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await finisher(c);
      await t.app.get(ProfilesService).ensure(me.userId);
      await prisma.profile.update({ where: { userId: me.userId }, data: { displayName: "आशा वर्मा Asha" } });
      await deliverCompleted(me.userId, c.id);
      const [cert] = await certs(me.userId, c.id);
      expect(cert.learnerName).toBe("आशा वर्मा Asha");

      const dl = await http().get(`/v1/certificates/${cert.code}/download`).set(auth(me));
      expect(dl.status).toBe(200);
      expect(dl.body.expiresAt).toBe(new Date(t.clock.now().getTime() + 300_000).toISOString());
      const file = await fetch(dl.body.url);
      expect(file.status).toBe(200);
      const bytes = Buffer.from(await file.arrayBuffer());
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
      expect(bytes.toString("latin1")).toMatch(/NotoSansDevanagari/);

      const stranger = await t.login();
      expect((await http().get(`/v1/certificates/${cert.code}/download`).set(auth(stranger))).status).toBe(404);
      expect((await http().get(`/v1/certificates/${cert.code}/download`).set(auth(owner))).status).toBe(404); // even the course author
      expect((await http().get(`/v1/certificates/${cert.code}/download`)).status).toBe(401);
    });

    it("tells the learner once", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await finisher(c);
      await deliverCompleted(me.userId, c.id, 2);
      const notes = await prisma.notification.findMany({ where: { userId: me.userId, type: "certificate.issued" } });
      expect(notes).toHaveLength(1);
      expect(notes[0].title).toMatch(/certificate/i);
    });

    it("issues nothing for someone who has not finished or no longer holds the course", async () => {
      const owner = await creator();
      const c = await course(owner);
      const stranger = await t.login();
      await bus.dispatch({ type: "course.completed", userId: stranger.userId, courseId: c.id }, `ev-${uniq()}`);
      expect(await certs(stranger.userId, c.id)).toHaveLength(0);

      const enrolled = await t.login();
      await http().post(`/v1/courses/${c.slug}/enrol`).set(auth(enrolled));
      await bus.dispatch({ type: "course.completed", userId: enrolled.userId, courseId: c.id }, `ev-${uniq()}`); // forged / early: not completed
      expect(await certs(enrolled.userId, c.id)).toHaveLength(0);

      const me = await finisher(c);
      await prisma.enrolment.update({ where: { courseId_userId: { courseId: c.id, userId: me.userId } }, data: { revokedAt: t.clock.now() } });
      await deliverCompleted(me.userId, c.id); // late redelivery after the enrolment ended
      expect(await certs(me.userId, c.id)).toHaveLength(0);
    });

    it("parallel deliveries of one event still give one live certificate", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await finisher(c);
      const [row] = await completedRows(me.userId, c.id);
      await Promise.all(Array.from({ length: 4 }, () => bus.dispatch({ type: "course.completed", ...(row.payload as object) } as DomainEvent, row.id)));
      expect((await certs(me.userId, c.id)).filter((x) => x.revokedAt === null)).toHaveLength(1);
    });

    it("retries with a new code when the drawn one is taken", async () => {
      const owner = await creator();
      const c = await course(owner);
      const first = await finisher(c);
      await deliverCompleted(first.userId, c.id);
      const [taken] = await certs(first.userId, c.id);

      const service = t.app.get(CertificatesService);
      const original = service.generateCode;
      const draws = [taken.code, taken.code, "ZZZZZZZZZZ"];
      service.generateCode = () => draws.shift() ?? original();
      try {
        const second = await finisher(c);
        await deliverCompleted(second.userId, c.id);
        const [cert] = await certs(second.userId, c.id);
        expect(cert.code).toBe("ZZZZZZZZZZ");
      } finally {
        service.generateCode = original;
      }
    });
  });

  describe("listing", () => {
    it("GET /v1/me/certificates shows my certificates (newest first), never anybody else's", async () => {
      const owner = await creator();
      const a = await course(owner);
      const b = await course(owner);
      const me = await finisher(a);
      const other = await finisher(a);
      await deliverCompleted(me.userId, a.id);
      t.clock.advanceSec(10);
      await http().post(`/v1/courses/${b.slug}/enrol`).set(auth(me));
      await http().post(`/v1/learn/lessons/${b.lessonId}/complete`).set(auth(me));
      await deliverCompleted(me.userId, b.id);
      await deliverCompleted(other.userId, a.id);

      const res = await http().get("/v1/me/certificates").set(auth(me));
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: { courseTitle: string }) => i.courseTitle)).toEqual([b.title, a.title]);
      expect(res.body.items[0]).toMatchObject({ status: "VALID", courseSlug: b.slug });
      expect(res.text).not.toContain(other.userId);
      expect((await http().get("/v1/me/certificates")).status).toBe(401);
    });
  });

  describe("public verification", () => {
    it("shows name, course, issuer, date and status to anyone, without an account, and nothing that identifies the user", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await finisher(c);
      await deliverCompleted(me.userId, c.id);
      const [cert] = await certs(me.userId, c.id);

      const res = await verify(cert.code);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(["code", "courseTitle", "issuedAt", "issuer", "learnerName", "status"]);
      expect(res.body).toEqual({ code: cert.code, learnerName: cert.learnerName, courseTitle: c.title, issuer: cert.issuerName, issuedAt: cert.issuedAt.toISOString(), status: "VALID" });
      expect(res.text).not.toContain(me.email);
      expect(res.text).not.toContain(me.userId);
      expect(res.text).not.toContain(cert.id);
      expect(res.text).not.toContain(owner.userId);
      expect(res.text).not.toContain(c.id);
      expect((await verify(cert.code.toLowerCase())).body.code).toBe(cert.code); // typed in lower case
    });

    it("404s for unknown and malformed codes", async () => {
      expect((await verify(NEVER)).status).toBe(404);
      expect((await verify(NEVER)).body.error.code).toBe("CERTIFICATE_NOT_FOUND");
      expect((await verify("short")).status).toBe(404);
      expect((await verify("0000000000")).status).toBe(404); // characters outside the alphabet
    });

    it("is rate limited to 60 a minute per IP", async () => {
      const ip = uniqueIp();
      for (let i = 0; i < 60; i++) expect((await verify(NEVER, ip)).status).toBe(404);
      const limited = await verify(NEVER, ip);
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
      expect((await verify(NEVER, uniqueIp())).status).toBe(404); // another IP is unaffected
    });
  });

  describe("revocation", () => {
    it("a refund of the course order revokes the certificate: verify says REVOKED, download is gone", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await finisher(c);
      await deliverCompleted(me.userId, c.id);
      const [cert] = await certs(me.userId, c.id);
      // a bought enrolment, refunded through the sellable hook inside a transaction (what onRefunded does)
      await prisma.enrolment.update({ where: { courseId_userId: { courseId: c.id, userId: me.userId } }, data: { source: "PURCHASE", orderId: "order-1" } });
      t.clock.advanceSec(30);
      await prisma.$transaction((tx) => t.app.get(EnrolmentsService).revokeForOrder(tx, { courseId: c.id, userId: me.userId, orderId: "order-1" }));

      const after = await prisma.certificate.findUniqueOrThrow({ where: { id: cert.id } });
      expect(after.revokedAt?.toISOString()).toBe(t.clock.now().toISOString());
      expect((await verify(cert.code)).body.status).toBe("REVOKED");
      const dl = await http().get(`/v1/certificates/${cert.code}/download`).set(auth(me));
      expect(dl.status).toBe(410);
      expect(dl.body.error.code).toBe("CERTIFICATE_REVOKED");
      expect((await http().get("/v1/me/certificates").set(auth(me))).body.items[0].status).toBe("REVOKED");
    });

    it("the order.refunded event revokes it too (redelivery safe), but only when the enrolment is really gone", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await finisher(c);
      await deliverCompleted(me.userId, c.id);
      const [cert] = await certs(me.userId, c.id);
      const refunded = (): DomainEvent => ({
        type: "order.refunded",
        orderId: "o1",
        refundId: "r1",
        buyerId: me.userId,
        sellerOwnerType: "USER",
        sellerOwnerId: owner.userId,
        itemType: "COURSE",
        itemId: c.id,
        itemTitle: c.title,
        amountPaise: "100000",
      });
      await bus.dispatch({ ...(refunded() as object), itemType: "WORKSHOP" } as DomainEvent, `ev-${uniq()}`); // another item type: ignored
      await bus.dispatch(refunded(), `ev-${uniq()}`); // enrolment still active: a refund of some other order must not cost the certificate
      expect((await prisma.certificate.findUniqueOrThrow({ where: { id: cert.id } })).revokedAt).toBeNull();

      await prisma.enrolment.update({ where: { courseId_userId: { courseId: c.id, userId: me.userId } }, data: { revokedAt: t.clock.now() } });
      const id = `ev-${uniq()}`;
      await bus.dispatch(refunded(), id);
      const first = (await prisma.certificate.findUniqueOrThrow({ where: { id: cert.id } })).revokedAt;
      expect(first).not.toBeNull();
      t.clock.advanceSec(5);
      await bus.dispatch(refunded(), id);
      expect((await prisma.certificate.findUniqueOrThrow({ where: { id: cert.id } })).revokedAt).toEqual(first); // unchanged
    });

    it("losing an organization seat revokes it as well", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await finisher(c);
      await deliverCompleted(me.userId, c.id);
      const [cert] = await certs(me.userId, c.id);
      const org = await prisma.organization.create({ data: { slug: `org-${uniq()}`, name: "Seat Org", ownerId: owner.userId } });
      await prisma.course.update({ where: { id: c.id }, data: { ownerType: "ORG", ownerId: org.id } });
      await prisma.enrolment.update({ where: { courseId_userId: { courseId: c.id, userId: me.userId } }, data: { source: "ORG_SEAT" } });
      expect(await t.app.get(EnrolmentsService).revokeOrgSeats(org.id, me.userId)).toBe(1); // holds no org_learner role in this org
      expect((await prisma.certificate.findUniqueOrThrow({ where: { id: cert.id } })).revokedAt).not.toBeNull();
    });

    it("a learner who gets the course back is issued a fresh certificate; the old one stays revoked", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await finisher(c);
      const firstEvent = await deliverCompleted(me.userId, c.id);
      const [old] = await certs(me.userId, c.id);
      await prisma.enrolment.update({ where: { courseId_userId: { courseId: c.id, userId: me.userId } }, data: { source: "PURCHASE", orderId: "order-2" } });
      t.clock.advanceSec(30);
      await prisma.$transaction((tx) => t.app.get(EnrolmentsService).revokeForOrder(tx, { courseId: c.id, userId: me.userId, orderId: "order-2" }));
      expect((await prisma.certificate.findUniqueOrThrow({ where: { id: old.id } })).revokedAt).not.toBeNull();

      // the first completion event arriving late does nothing while the enrolment is revoked
      await bus.dispatch({ type: "course.completed", ...(firstEvent.payload as object) } as DomainEvent, firstEvent.id);
      expect(await certs(me.userId, c.id)).toHaveLength(1);

      // they enrol again (free course): the finished course is announced once more and certified again
      t.clock.advanceSec(30);
      expect((await http().post(`/v1/courses/${c.slug}/enrol`).set(auth(me))).status).toBe(201);
      expect(await completedRows(me.userId, c.id)).toHaveLength(2);
      await deliverCompleted(me.userId, c.id, 2);
      const all = await certs(me.userId, c.id);
      expect(all).toHaveLength(2);
      expect(all.filter((x) => x.revokedAt === null)).toHaveLength(1);
      expect(all.find((x) => x.revokedAt === null)!.id).not.toBe(old.id);
      expect((await verify(old.code)).body.status).toBe("REVOKED");
    });
  });

  describe("learner name privacy (pending name)", () => {
    it("a learner who never set a name gets a PENDING_NAME certificate: no PDF, nothing public, a prompt to name it", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await finisher(c, null);
      await deliverCompleted(me.userId, c.id, 2);
      const [cert] = await certs(me.userId, c.id);
      expect(cert).toMatchObject({ state: "PENDING_NAME", learnerName: null, objectKey: null });
      expect((await verify(cert.code)).status).toBe(404);
      const list = await http().get("/v1/me/certificates").set(auth(me));
      expect(list.body.items[0]).toMatchObject({ id: cert.id, status: "PENDING_NAME", learnerName: null });
      const dl = await http().get("/v1/certificates/" + cert.code + "/download").set(auth(me));
      expect(dl.status).toBe(409);
      expect(dl.body.error.code).toBe("CERTIFICATE_NAME_REQUIRED");
      const notes = await prisma.notification.findMany({ where: { userId: me.userId, type: "certificate.name_needed" } });
      expect(notes).toHaveLength(1);
      expect(await prisma.notification.count({ where: { userId: me.userId, type: "certificate.issued" } })).toBe(0);
    });

    it("the owner sets the name once: sanitised, PDF generated, then it is VALID and public; the snapshot never changes again", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await finisher(c, null);
      await deliverCompleted(me.userId, c.id);
      const [cert] = await certs(me.userId, c.id);
      const url = "/v1/me/certificates/" + cert.id + "/name";

      const intruder = await t.login();
      expect((await http().post(url).set(auth(intruder)).send({ name: "Mallory" })).status).toBe(404);
      expect((await http().post(url).send({ name: "Mallory" })).status).toBe(401);
      expect((await http().post(url).set(auth(me)).send({ name: "\u200B \n " })).status).toBe(422);
      expect((await http().post(url).set(auth(me)).send({})).status).toBe(400);

      const ok = await http().post(url).set(auth(me)).send({ name: "  Asha\n\u202EVerma\u200B  Rao " });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ id: cert.id, status: "VALID", learnerName: "Asha Verma Rao" });
      const row = await prisma.certificate.findUniqueOrThrow({ where: { id: cert.id } });
      expect(row).toMatchObject({ state: "VALID", learnerName: "Asha Verma Rao", objectKey: "certificates/" + cert.id + ".pdf" });
      expect((await verify(cert.code)).body).toMatchObject({ learnerName: "Asha Verma Rao", status: "VALID" });
      const dl = await http().get("/v1/certificates/" + cert.code + "/download").set(auth(me));
      const bytes = Buffer.from(await (await fetch(dl.body.url)).arrayBuffer());
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");

      const again = await http().post(url).set(auth(me)).send({ name: "Someone Else" });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("CERTIFICATE_NAME_SET");
      expect((await prisma.certificate.findUniqueOrThrow({ where: { id: cert.id } })).learnerName).toBe("Asha Verma Rao");
    });

    it("the public page and the stored snapshot never carry the email-derived default name", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await finisher(c, null);
      await deliverCompleted(me.userId, c.id);
      const [cert] = await certs(me.userId, c.id);
      const local = me.email.split("@")[0];
      expect((await verify(cert.code)).text).not.toContain(local);
      expect(JSON.stringify(await prisma.certificate.findUniqueOrThrow({ where: { id: cert.id } }))).not.toContain(local);
    });

    it("a revoked pending certificate cannot be named", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await finisher(c, null);
      await deliverCompleted(me.userId, c.id);
      const [cert] = await certs(me.userId, c.id);
      await prisma.certificate.update({ where: { id: cert.id }, data: { revokedAt: t.clock.now() } });
      expect((await http().post("/v1/me/certificates/" + cert.id + "/name").set(auth(me)).send({ name: "Asha" })).status).toBe(410);
    });
  });

  describe("snapshot sanitising", () => {
    it("normalises learner, course and issuer text: no newlines, controls, zero-width or bidi overrides, capped lengths", async () => {
      const owner = await creator();
      const c = await course(owner);
      await t.app.get(ProfilesService).ensure(owner.userId);
      await prisma.profile.update({ where: { userId: owner.userId }, data: { displayName: "Dr\u202E Rao\u2066\nMD" } });
      await prisma.course.update({ where: { id: c.id }, data: { title: "Adv\nCardiology\u200B " + "x".repeat(200) } });
      const me = await finisher(c, "Asha\n  has successfully completed\u202E the course\u200F\u0007 " + "y".repeat(100));
      await deliverCompleted(me.userId, c.id);
      const [cert] = await certs(me.userId, c.id);
      expect(cert.learnerName).toBe(("Asha has successfully completed the course " + "y".repeat(100)).slice(0, 80));
      expect(cert.issuerName).toBe("Dr Rao MD");
      expect(cert.courseTitle).toMatch(/^Adv Cardiology x+$/);
      expect(Array.from(cert.courseTitle).length).toBe(120);
      const body = (await verify(cert.code)).text;
      expect(body).not.toMatch(/[\p{C}\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u);
      expect(body).not.toContain("\\n");
    });
  });

  describe("organization issuer and seats", () => {
    it("an organization course prints the organization name; a missing organization fails (retryable) instead of an invented issuer", async () => {
      const owner = await creator();
      const c = await course(owner);
      const org = await prisma.organization.create({ data: { slug: "org-" + uniq(), name: "  Acme\nAcademy ", ownerId: owner.userId } });
      await prisma.course.update({ where: { id: c.id }, data: { ownerType: "ORG", ownerId: org.id } });
      const me = await finisher(c);
      await deliverCompleted(me.userId, c.id);
      expect((await certs(me.userId, c.id))[0].issuerName).toBe("Acme Academy");

      await expect(t.app.get(OrganizationDirectory).nameOf("00000000-0000-7000-8000-000000000000")).rejects.toMatchObject({ code: "ORG_NOT_FOUND" });
      const c2 = await course(owner);
      await prisma.course.update({ where: { id: c2.id }, data: { ownerType: "ORG", ownerId: "00000000-0000-7000-8000-000000000000" } });
      const me2 = await finisher(c2);
      await expect(deliverCompleted(me2.userId, c2.id)).rejects.toMatchObject({ code: "ORG_NOT_FOUND" });
      expect(await certs(me2.userId, c2.id)).toHaveLength(0);
    });

    it("an org seat whose grant has expired (sweep not yet run) is not certified; a live seat is", async () => {
      const owner = await creator();
      const c = await course(owner);
      const org = await prisma.organization.create({ data: { slug: "org-" + uniq(), name: "Seat Org", ownerId: owner.userId } });
      await prisma.course.update({ where: { id: c.id }, data: { ownerType: "ORG", ownerId: org.id } });
      const role = await prisma.role.findUniqueOrThrow({ where: { key: "org_learner" } });

      const expired = await finisher(c);
      await prisma.enrolment.update({ where: { courseId_userId: { courseId: c.id, userId: expired.userId } }, data: { source: "ORG_SEAT" } });
      await prisma.userRole.create({ data: { userId: expired.userId, roleId: role.id, orgId: org.id, expiresAt: new Date(t.clock.now().getTime() - 60_000) } });
      await deliverCompleted(expired.userId, c.id);
      expect(await certs(expired.userId, c.id)).toHaveLength(0);

      const live = await finisher(c);
      await prisma.enrolment.update({ where: { courseId_userId: { courseId: c.id, userId: live.userId } }, data: { source: "ORG_SEAT" } });
      await prisma.userRole.create({ data: { userId: live.userId, roleId: role.id, orgId: org.id } });
      await deliverCompleted(live.userId, c.id);
      expect(await certs(live.userId, c.id)).toHaveLength(1);
    });
  });
});
