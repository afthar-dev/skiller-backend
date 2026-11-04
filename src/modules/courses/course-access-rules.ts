import { Injectable } from "@nestjs/common";
import type { Course } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { PlatformRoleDirectory } from "../rbac";
import { ORG_AUTHOR_ROLES } from "./org-roles";

export const ORG_LEARNER_ROLE = "org_learner";

/** How a user stands to a course when they want to get it. Precedence: OWN, ORG_AUTHOR, ENROLLED, ORG_LEARNER, NONE. */
export type BuyerRelation = "OWN" | "ORG_AUTHOR" | "ENROLLED" | "ORG_LEARNER" | "NONE";

type Owned = Pick<Course, "id" | "ownerType" | "ownerId">;

/**
 * The one place that decides what a user is to a course for buying and enrolling. Checkout (the COURSE sellable) and the
 * enrol endpoint both ask it, so they cannot disagree about who pays and who takes a seat. Worker-safe: database and role directory only.
 */
@Injectable()
export class CourseAccessRules {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: PlatformRoleDirectory,
  ) {}

  async buyerRelation(userId: string, course: Owned): Promise<BuyerRelation> {
    let orgRoles: string[] = [];
    if (course.ownerType === "USER") {
      if (course.ownerId === userId) return "OWN";
    } else {
      orgRoles = await this.roles.roleKeysInOrg(userId, course.ownerId);
      if (orgRoles.some((r) => (ORG_AUTHOR_ROLES as readonly string[]).includes(r))) return "ORG_AUTHOR";
    }
    if (await this.prisma.enrolment.findFirst({ where: { userId, courseId: course.id, revokedAt: null }, select: { id: true } })) return "ENROLLED";
    return orgRoles.includes(ORG_LEARNER_ROLE) ? "ORG_LEARNER" : "NONE";
  }

  /** The user holds a live (not expired) org-scoped org_learner grant in the organization that owns the course. Access checks for ORG_SEAT enrolments use this. */
  async hasLiveSeat(userId: string, courseId: string): Promise<boolean> {
    const course = await this.prisma.course.findUnique({ where: { id: courseId }, select: { ownerType: true, ownerId: true } });
    if (!course || course.ownerType !== "ORG") return false;
    return (await this.roles.roleKeysInOrg(userId, course.ownerId)).includes(ORG_LEARNER_ROLE);
  }
}
