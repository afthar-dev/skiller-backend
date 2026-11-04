import { Injectable } from "@nestjs/common";
import type { EnrolmentSource } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { PlatformRoleDirectory } from "../rbac";
import { EnrolmentsService, ORG_LEARNER_ROLE, toEnrolmentView, withCourse, type EnrolmentView } from "./enrolments.service";
import { ORG_AUTHOR_ROLES } from "./org-roles";

const notFound = () => new AppError("COURSE_NOT_FOUND", 404, "Course not found");

/** Enrolment without checkout: free courses for everyone, and every course of an organization for its learners (a seat). */
@Injectable()
export class SelfEnrolmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enrolments: EnrolmentsService,
    private readonly roles: PlatformRoleDirectory,
  ) {}

  /**
   * Enrols the user in a published course. Already enrolled (even in a course since unpublished) returns the enrolment unchanged.
   * An author of the course cannot (they have access as authors); a paid course for anyone but an org learner of the owning
   * organization is COURSE_PAYMENT_REQUIRED (402): that goes through checkout.
   */
  async enrol(userId: string, slug: string): Promise<{ enrolment: EnrolmentView; created: boolean }> {
    const course = await this.prisma.course.findUnique({ where: { slug } });
    if (!course) throw notFound();

    const existing = await this.enrolments.activeFor(userId, course.id);
    if (existing) return { enrolment: await this.view(existing.id), created: false };
    if (course.status !== "PUBLISHED" || course.flaggedAt) throw notFound();

    let orgRoles: string[] = [];
    if (course.ownerType === "USER") {
      if (course.ownerId === userId) throw this.own();
    } else {
      orgRoles = await this.roles.roleKeysInOrg(userId, course.ownerId);
      if (orgRoles.some((r) => (ORG_AUTHOR_ROLES as readonly string[]).includes(r))) throw this.own();
    }

    let source: EnrolmentSource;
    if (course.pricePaise === 0n) source = "FREE";
    else if (orgRoles.includes(ORG_LEARNER_ROLE)) source = "ORG_SEAT";
    else throw new AppError("COURSE_PAYMENT_REQUIRED", 402, "This course has to be purchased", { pricePaise: course.pricePaise.toString() });

    const { enrolment, changed } = await this.prisma.$transaction((tx) => this.enrolments.grant(tx, { courseId: course.id, userId, source }));
    return { enrolment: await this.view(enrolment.id), created: changed };
  }

  private own() {
    return new AppError("COURSE_OWN", 409, "You author this course");
  }

  private async view(id: string): Promise<EnrolmentView> {
    return toEnrolmentView(await this.prisma.enrolment.findUniqueOrThrow({ where: { id }, include: withCourse }));
  }
}
