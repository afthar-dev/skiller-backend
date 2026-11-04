import { Injectable } from "@nestjs/common";
import type { Course } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { PermissionService, PlatformRoleDirectory } from "../rbac";
import { ORG_AUTHOR_ROLES } from "./org-roles";

export const ORG_LEARNER_ROLE = "org_learner";

/** How a user stands to a course when they want to get it. Precedence: OWN, ORG_AUTHOR, ENROLLED, ORG_LEARNER, NONE. An ORG_SEAT enrolment without a live seat does not make ENROLLED. */
export type BuyerRelation = "OWN" | "ORG_AUTHOR" | "ENROLLED" | "ORG_LEARNER" | "NONE";

type Owned = Pick<Course, "id" | "ownerType" | "ownerId">;
/** What access decisions need to know about a course. */
export type AccessCourse = Owned & Pick<Course, "status" | "flaggedAt">;

/**
 * How a user came to be allowed into a course's content. `progress` says whether their activity counts towards the course
 * (only an enrolment does: previews, moderation and authoring never write progress).
 */
export interface LearnAccess {
  via: "ENROLLED" | "AUTHOR" | "PREVIEW" | "REVIEW";
  progress: boolean;
}

/**
 * The one place that decides what a user is to a course for buying and enrolling. Checkout (the COURSE sellable) and the
 * enrol endpoint both ask it, so they cannot disagree about who pays and who takes a seat. Worker-safe: database and role directory only.
 */
@Injectable()
export class CourseAccessRules {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: PlatformRoleDirectory,
    private readonly permissions: PermissionService,
  ) {}

  async buyerRelation(userId: string, course: Owned): Promise<BuyerRelation> {
    let orgRoles: string[] = [];
    if (course.ownerType === "USER") {
      if (course.ownerId === userId) return "OWN";
    } else {
      orgRoles = await this.roles.roleKeysInOrg(userId, course.ownerId);
      if (orgRoles.some((r) => (ORG_AUTHOR_ROLES as readonly string[]).includes(r))) return "ORG_AUTHOR";
    }
    const enrolment = await this.prisma.enrolment.findFirst({ where: { userId, courseId: course.id, revokedAt: null }, select: { source: true } });
    // A seat only counts while the org_learner grant behind it is live: after it expired and before the daily sweep revoked the row, the user may buy or enrol again.
    if (enrolment && (enrolment.source !== "ORG_SEAT" || orgRoles.includes(ORG_LEARNER_ROLE))) return "ENROLLED";
    return orgRoles.includes(ORG_LEARNER_ROLE) ? "ORG_LEARNER" : "NONE";
  }

  /**
   * The single access decision for course content (lessons, videos, resources, progress). Nothing is cached: every call reads the
   * current enrolment and grants, so a refund or a lost seat takes effect on the next request.
   *  1. An active enrolment; for an ORG_SEAT one the user must also hold a live org_learner grant.
   *  2. An author (owner, org owner / instructor) or a holder of course.manage_any.
   *  3. A free-preview lesson of a PUBLISHED, unflagged course: anyone (no progress).
   *  4. A holder of course.review, for courses in review, published or flagged (moderation, no progress).
   * `lesson` is omitted when asking about the course as a whole, which never grants rule 3.
   */
  async learnAccess(userId: string, course: AccessCourse, lesson?: { isFreePreview: boolean }): Promise<LearnAccess | null> {
    const enrolment = await this.prisma.enrolment.findFirst({ where: { userId, courseId: course.id, revokedAt: null }, select: { source: true } });
    if (enrolment && (enrolment.source !== "ORG_SEAT" || (await this.holdsSeat(userId, course)))) return { via: "ENROLLED", progress: true };

    const relation = await this.buyerRelation(userId, course);
    if (relation === "OWN" || relation === "ORG_AUTHOR" || (await this.permissions.has(userId, "course.manage_any"))) return { via: "AUTHOR", progress: false };

    if (lesson?.isFreePreview && course.status === "PUBLISHED" && !course.flaggedAt) return { via: "PREVIEW", progress: false };

    const reviewable = course.status === "IN_REVIEW" || course.status === "PUBLISHED" || course.flaggedAt !== null;
    if (reviewable && (await this.permissions.has(userId, "course.review"))) return { via: "REVIEW", progress: false };
    return null;
  }

  async canLearn(userId: string, target: { lessonId: string } | { course: AccessCourse; lesson?: { isFreePreview: boolean } }): Promise<boolean> {
    if ("lessonId" in target) {
      const lesson = await this.prisma.lesson.findUnique({ where: { id: target.lessonId }, select: { isFreePreview: true, course: true } });
      return lesson !== null && (await this.learnAccess(userId, lesson.course, lesson)) !== null;
    }
    return (await this.learnAccess(userId, target.course, target.lesson)) !== null;
  }

  private async holdsSeat(userId: string, course: Pick<Owned, "ownerType" | "ownerId">): Promise<boolean> {
    return course.ownerType === "ORG" && (await this.roles.roleKeysInOrg(userId, course.ownerId)).includes(ORG_LEARNER_ROLE);
  }

  /** The user holds a live (not expired) org-scoped org_learner grant in the organization that owns the course. Access checks for ORG_SEAT enrolments use this. */
  async hasLiveSeat(userId: string, courseId: string): Promise<boolean> {
    const course = await this.prisma.course.findUnique({ where: { id: courseId }, select: { ownerType: true, ownerId: true } });
    if (!course || course.ownerType !== "ORG") return false;
    return this.holdsSeat(userId, course);
  }
}
