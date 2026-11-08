import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma, type Certificate } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ObjectStorage } from "../media";
import { OrganizationDirectory } from "../organizations";
import { ProfilesService } from "../users";
import { CERTIFICATE_CODE_ALPHABET, CERTIFICATE_CODE_LENGTH, CERTIFICATE_NAME_MAX, CERTIFICATE_TITLE_MAX, generateCertificateCode, renderCertificatePdf, sanitizeSnapshotText } from "./certificate-document";
import { revokeCertificates } from "./certificate-revocation";
import { CourseAccessRules } from "./course-access-rules";

/** Certificate downloads are presigned for this long. */
export const CERTIFICATE_URL_TTL_SEC = 300;
/** How often a taken code is redrawn before giving up (a 31^10 space: a second draw is already astronomically unlikely). */
const MAX_CODE_DRAWS = 8;

const CODE_PATTERN = new RegExp(`^[${CERTIFICATE_CODE_ALPHABET}]{${CERTIFICATE_CODE_LENGTH}}$`);
const notFound = () => new AppError("CERTIFICATE_NOT_FOUND", 404, "Certificate not found");

export interface CertificateView {
  id: string;
  code: string;
  courseId: string;
  courseSlug: string;
  courseTitle: string;
  /** Null while PENDING_NAME. */
  learnerName: string | null;
  issuer: string;
  issuedAt: string;
  status: "VALID" | "REVOKED" | "PENDING_NAME";
}

export interface PublicCertificate {
  code: string;
  learnerName: string;
  courseTitle: string;
  issuer: string;
  issuedAt: string;
  status: "VALID" | "REVOKED";
}

const status = (c: Pick<Certificate, "revokedAt">) => (c.revokedAt ? ("REVOKED" as const) : ("VALID" as const));
const ownerStatus = (c: Pick<Certificate, "revokedAt" | "state">) => (c.revokedAt ? ("REVOKED" as const) : c.state === "PENDING_NAME" ? ("PENDING_NAME" as const) : ("VALID" as const));

/**
 * Certificates of completion. The same class runs in the API (list, verify, download) and in the worker (issuing on `course.completed`,
 * revoking on refunds), so it needs only the database, storage, profiles and the clock.
 */
@Injectable()
export class CertificatesService {
  /** The code source; replaceable so tests can force collisions. */
  generateCode: () => string = generateCertificateCode;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorage,
    private readonly profiles: ProfilesService,
    private readonly orgs: OrganizationDirectory,
    private readonly rules: CourseAccessRules,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Issues the learner's certificate for a course they finished. Idempotent: a learner has at most one live certificate per course
   * (also enforced by a partial unique index), so redelivered or concurrent events return the same one. Returns null when the learner
   * has not finished or no longer holds the course (a late event after a refund must not certify anyone).
   */
  async issue(userId: string, courseId: string): Promise<Certificate | null> {
    if (!(await this.holdsFinishedCourse(this.prisma, userId, courseId))) return null;
    const live = await this.live(userId, courseId);
    if (live) return live;

    const course = await this.prisma.course.findUnique({ where: { id: courseId }, select: { title: true, ownerType: true, ownerId: true } });
    if (!course) return null;
    const courseTitle = sanitizeSnapshotText(course.title, CERTIFICATE_TITLE_MAX) || "Course";
    const issuerName = sanitizeSnapshotText(course.ownerType === "USER" ? await this.profiles.displayNameOf(course.ownerId) : await this.orgs.nameOf(course.ownerId), CERTIFICATE_NAME_MAX) || "Skiller";
    // A learner who never chose a name still has the one made from their email address: that must not reach a public page or a PDF.
    const learnerName = (await this.profiles.isDefaultDisplayName(userId)) ? "" : sanitizeSnapshotText(await this.profiles.displayNameOf(userId), CERTIFICATE_NAME_MAX);

    for (let draw = 0; draw < MAX_CODE_DRAWS; draw++) {
      const code = this.generateCode();
      if (await this.prisma.certificate.findUnique({ where: { code }, select: { id: true } })) continue;
      const id = randomUUID();
      const issuedAt = this.clock.now();
      const objectKey = learnerName ? `certificates/${id}.pdf` : null;
      if (objectKey) await this.storage.putPrivate(objectKey, await this.render({ code, learnerName, courseTitle, issuerName, issuedAt }), "application/pdf");
      try {
        return await this.prisma.$transaction(async (tx) => {
          // The learner's enrolment row serialises this with a refund or seat loss: whoever comes second sees the other's result.
          await tx.$queryRaw`SELECT "id" FROM "enrolments" WHERE "courseId" = ${courseId} AND "userId" = ${userId} FOR UPDATE`;
          if (!(await this.holdsFinishedCourse(tx, userId, courseId))) return null;
          const existing = await tx.certificate.findFirst({ where: { userId, courseId, revokedAt: null } });
          if (existing) return existing;
          return tx.certificate.create({
            data: { id, code, courseId, userId, learnerName: learnerName || null, courseTitle, issuerName, issuedAt, objectKey, state: learnerName ? "VALID" : "PENDING_NAME" },
          });
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
        // The code was taken meanwhile (draw again) or another delivery issued the live certificate first (return it).
        const raced = await this.live(userId, courseId);
        if (raced) return raced;
      }
    }
    throw new Error(`could not find a free certificate code for user ${userId} and course ${courseId}`);
  }

  /**
   * The owner names a PENDING_NAME certificate, once: the text is sanitised, the PDF is made and the certificate becomes VALID.
   * From then on the snapshot never changes.
   */
  async setName(userId: string, certificateId: string, rawName: string): Promise<CertificateView> {
    const cert = await this.prisma.certificate.findUnique({ where: { id: certificateId }, include: { course: { select: { slug: true } } } });
    if (!cert || cert.userId !== userId) throw notFound();
    if (cert.revokedAt) throw new AppError("CERTIFICATE_REVOKED", 410, "This certificate has been revoked");
    if (cert.state !== "PENDING_NAME") throw new AppError("CERTIFICATE_NAME_SET", 409, "The name on this certificate is already set");
    const learnerName = sanitizeSnapshotText(rawName, CERTIFICATE_NAME_MAX);
    if (!learnerName) throw new AppError("CERTIFICATE_NAME_INVALID", 422, "Enter a name made of visible characters");

    const objectKey = `certificates/${cert.id}.pdf`;
    await this.storage.putPrivate(objectKey, await this.render({ code: cert.code, learnerName, courseTitle: cert.courseTitle, issuerName: cert.issuerName, issuedAt: cert.issuedAt }), "application/pdf");
    const done = await this.prisma.certificate.updateMany({ where: { id: cert.id, state: "PENDING_NAME", revokedAt: null }, data: { learnerName, objectKey, state: "VALID" } });
    if (done.count === 0) throw new AppError("CERTIFICATE_NAME_SET", 409, "The name on this certificate is already set");
    return this.view({ ...cert, learnerName, objectKey, state: "VALID" });
  }

  private render(f: { code: string; learnerName: string; courseTitle: string; issuerName: string; issuedAt: Date }): Promise<Buffer> {
    return renderCertificatePdf({ code: f.code, learnerName: f.learnerName, courseTitle: f.courseTitle, issuerName: f.issuerName, issuedAt: f.issuedAt.toISOString(), verifyUrl: `${this.config.webBaseUrl}/certificates/${f.code}` });
  }

  private view(c: Certificate & { course: { slug: string } }): CertificateView {
    return { id: c.id, code: c.code, courseId: c.courseId, courseSlug: c.course.slug, courseTitle: c.courseTitle, learnerName: c.learnerName, issuer: c.issuerName, issuedAt: c.issuedAt.toISOString(), status: ownerStatus(c) };
  }

  /** A refund of a COURSE order took the course away: the certificate goes with it. Only when the learner really holds no active enrolment any more. */
  async revokeIfEnrolmentEnded(userId: string, courseId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "enrolments" WHERE "courseId" = ${courseId} AND "userId" = ${userId} FOR UPDATE`;
      if (await tx.enrolment.count({ where: { courseId, userId, revokedAt: null } })) return false;
      return (await revokeCertificates(tx, courseId, userId, this.clock.now())) > 0;
    });
  }

  async mine(userId: string, page: PageQuery) {
    const rows = await this.prisma.certificate.findMany({
      where: { userId },
      include: { course: { select: { slug: true } } },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      take: page.limit + 1,
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    return {
      items: items.map((c) => this.view(c)),
      nextCursor,
    };
  }

  /** What anyone holding the code may see. Deliberately no user id, email, certificate id or course id. */
  async verify(rawCode: string): Promise<PublicCertificate> {
    const cert = await this.byCode(rawCode);
    // A certificate still waiting for its name is not public: there is nothing to show but a code.
    if (!cert || cert.state !== "VALID" || cert.learnerName === null) throw notFound();
    return { code: cert.code, learnerName: cert.learnerName, courseTitle: cert.courseTitle, issuer: cert.issuerName, issuedAt: cert.issuedAt.toISOString(), status: status(cert) };
  }

  /** The owner's short-lived link to the PDF. Anyone else (the course author included) gets the same 404 as for an unknown code. */
  async download(userId: string, rawCode: string): Promise<{ url: string; expiresAt: string }> {
    const cert = await this.byCode(rawCode);
    if (!cert || cert.userId !== userId) throw notFound();
    if (cert.revokedAt) throw new AppError("CERTIFICATE_REVOKED", 410, "This certificate has been revoked");
    if (cert.state !== "VALID" || !cert.objectKey) throw new AppError("CERTIFICATE_NAME_REQUIRED", 409, "Set the name for this certificate first");
    const url = await this.storage.presignPrivateGet(cert.objectKey, { expiresInSec: CERTIFICATE_URL_TTL_SEC, filename: `certificate-${cert.code}.pdf` });
    return { url, expiresAt: new Date(this.clock.now().getTime() + CERTIFICATE_URL_TTL_SEC * 1000).toISOString() };
  }

  private async byCode(rawCode: string): Promise<Certificate | null> {
    const code = rawCode.trim().toUpperCase();
    return CODE_PATTERN.test(code) ? this.prisma.certificate.findUnique({ where: { code } }) : null;
  }

  private live(userId: string, courseId: string): Promise<Certificate | null> {
    return this.prisma.certificate.findFirst({ where: { userId, courseId, revokedAt: null } });
  }

  private async holdsFinishedCourse(db: Prisma.TransactionClient | PrismaService, userId: string, courseId: string): Promise<boolean> {
    const e = await db.enrolment.findUnique({ where: { courseId_userId: { courseId, userId } }, select: { revokedAt: true, completedAt: true, source: true } });
    if (e === null || e.revokedAt !== null || e.completedAt === null) return false;
    // An organization seat counts only while the grant is live: the daily sweep may not have ended an expired one yet.
    return e.source !== "ORG_SEAT" || (await this.rules.hasLiveSeat(userId, courseId, db));
  }
}
