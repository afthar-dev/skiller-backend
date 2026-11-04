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
import { ProfilesService } from "../users";
import { CERTIFICATE_CODE_ALPHABET, CERTIFICATE_CODE_LENGTH, generateCertificateCode, renderCertificatePdf } from "./certificate-document";
import { revokeCertificates } from "./certificate-revocation";

/** Certificate downloads are presigned for this long. */
export const CERTIFICATE_URL_TTL_SEC = 300;
/** How often a taken code is redrawn before giving up (a 31^10 space: a second draw is already astronomically unlikely). */
const MAX_CODE_DRAWS = 8;

const CODE_PATTERN = new RegExp(`^[${CERTIFICATE_CODE_ALPHABET}]{${CERTIFICATE_CODE_LENGTH}}$`);
const notFound = () => new AppError("CERTIFICATE_NOT_FOUND", 404, "Certificate not found");

export interface CertificateView {
  code: string;
  courseId: string;
  courseSlug: string;
  courseTitle: string;
  learnerName: string;
  issuer: string;
  issuedAt: string;
  status: "VALID" | "REVOKED";
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
    const learnerName = await this.profiles.displayNameOf(userId);
    const issuerName = course.ownerType === "USER" ? await this.profiles.displayNameOf(course.ownerId) : await this.orgName(course.ownerId);

    for (let draw = 0; draw < MAX_CODE_DRAWS; draw++) {
      const code = this.generateCode();
      if (await this.prisma.certificate.findUnique({ where: { code }, select: { id: true } })) continue;
      const id = randomUUID();
      const issuedAt = this.clock.now();
      const objectKey = `certificates/${id}.pdf`;
      const pdf = await renderCertificatePdf({ code, learnerName, courseTitle: course.title, issuerName, issuedAt: issuedAt.toISOString(), verifyUrl: `${this.config.webBaseUrl}/certificates/${code}` });
      await this.storage.putPrivate(objectKey, pdf, "application/pdf");
      try {
        return await this.prisma.$transaction(async (tx) => {
          // The learner's enrolment row serialises this with a refund or seat loss: whoever comes second sees the other's result.
          await tx.$queryRaw`SELECT "id" FROM "enrolments" WHERE "courseId" = ${courseId} AND "userId" = ${userId} FOR UPDATE`;
          if (!(await this.holdsFinishedCourse(tx, userId, courseId))) return null;
          const existing = await tx.certificate.findFirst({ where: { userId, courseId, revokedAt: null } });
          if (existing) return existing;
          return tx.certificate.create({ data: { id, code, courseId, userId, learnerName, courseTitle: course.title, issuerName, issuedAt, objectKey } });
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
      items: items.map((c): CertificateView => ({ code: c.code, courseId: c.courseId, courseSlug: c.course.slug, courseTitle: c.courseTitle, learnerName: c.learnerName, issuer: c.issuerName, issuedAt: c.issuedAt.toISOString(), status: status(c) })),
      nextCursor,
    };
  }

  /** What anyone holding the code may see. Deliberately no user id, email, certificate id or course id. */
  async verify(rawCode: string): Promise<PublicCertificate> {
    const cert = await this.byCode(rawCode);
    if (!cert) throw notFound();
    return { code: cert.code, learnerName: cert.learnerName, courseTitle: cert.courseTitle, issuer: cert.issuerName, issuedAt: cert.issuedAt.toISOString(), status: status(cert) };
  }

  /** The owner's short-lived link to the PDF. Anyone else (the course author included) gets the same 404 as for an unknown code. */
  async download(userId: string, rawCode: string): Promise<{ url: string; expiresAt: string }> {
    const cert = await this.byCode(rawCode);
    if (!cert || cert.userId !== userId) throw notFound();
    if (cert.revokedAt) throw new AppError("CERTIFICATE_REVOKED", 410, "This certificate has been revoked");
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
    const e = await db.enrolment.findUnique({ where: { courseId_userId: { courseId, userId } }, select: { revokedAt: true, completedAt: true } });
    return e !== null && e.revokedAt === null && e.completedAt !== null;
  }

  /** Organization names are read straight from the row: the worker process has no organizations service to ask (billing does the same for invoices). */
  private async orgName(orgId: string): Promise<string> {
    return (await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }))?.name ?? "Organization";
  }
}
