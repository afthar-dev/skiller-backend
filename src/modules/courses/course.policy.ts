import { Injectable } from "@nestjs/common";
import type { Course, CourseOwnerType } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { PermissionService, PlatformRoleDirectory } from "../rbac";
import { ProfilesService } from "../users";

/** Org roles that may author the organization's courses. Platform-wide grants of these roles do not count: only org-scoped membership does. */
export const ORG_AUTHOR_ROLES = ["org_owner", "org_instructor"] as const;

type Owned = Pick<Course, "ownerType" | "ownerId">;

export const courseNotFound = () => new AppError("COURSE_NOT_FOUND", 404, "Course not found");

/**
 * The single place that decides who may create, author and moderate courses. Controllers call it; services never re-implement it.
 * Unknown and unauthorised courses are indistinguishable (404); a member of the owning org without an authoring role gets 403.
 */
@Injectable()
export class CoursePolicy {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
    private readonly permissions: PermissionService,
    private readonly roles: PlatformRoleDirectory,
  ) {}

  /** Creator for USER courses (the owner is the user); org_owner / org_instructor of that org for ORG courses. */
  async canCreateFor(user: { id: string }, ownerType: CourseOwnerType, ownerId: string): Promise<boolean> {
    if (ownerType === "USER") return ownerId === user.id && (await this.profiles.isCreator(user.id));
    return this.isOrgAuthor(user.id, ownerId);
  }

  async assertCanCreateFor(user: { id: string }, ownerType: CourseOwnerType, ownerId: string): Promise<void> {
    if (await this.canCreateFor(user, ownerType, ownerId)) return;
    if (ownerType === "USER") throw new AppError("CREATOR_REQUIRED", 403, "Become a creator to publish courses");
    throw new AppError("FORBIDDEN", 403, "You cannot create courses for this organization");
  }

  /** The owner, an author of the owning org, or a holder of `course.manage_any`. */
  async canAuthor(user: { id: string }, course: Owned): Promise<boolean> {
    if (course.ownerType === "USER" && course.ownerId === user.id) return true;
    if (course.ownerType === "ORG" && (await this.isOrgAuthor(user.id, course.ownerId))) return true;
    return this.permissions.has(user.id, "course.manage_any");
  }

  /** Moderators (`course.review`) and course admins (`course.manage_any`); platform-wide grants only. */
  async canModerate(user: { id: string }): Promise<boolean> {
    return (await this.permissions.has(user.id, "course.review")) || (await this.permissions.has(user.id, "course.manage_any"));
  }

  async isOrgAuthor(userId: string, orgId: string): Promise<boolean> {
    const keys = await this.roles.roleKeysInOrg(userId, orgId);
    return keys.some((k) => (ORG_AUTHOR_ROLES as readonly string[]).includes(k));
  }

  /** Organizations whose courses the user may author. */
  authoredOrgIds(userId: string): Promise<string[]> {
    return this.roles.orgIdsWithAnyRole(userId, ORG_AUTHOR_ROLES);
  }

  /** 404 unless the user may author the course; an org member who may not gets 403 (they already know the course exists). */
  async assertCanAuthor(user: { id: string }, course: Course): Promise<void> {
    if (await this.canAuthor(user, course)) return;
    if (course.ownerType === "ORG" && (await this.roles.roleKeysInOrg(user.id, course.ownerId)).length > 0) {
      throw new AppError("FORBIDDEN", 403, "Your role in this organization cannot edit its courses");
    }
    throw courseNotFound();
  }

  async loadForAuthor(user: { id: string }, courseId: string): Promise<Course> {
    const course = await this.prisma.course.findUnique({ where: { id: courseId } });
    if (!course) throw courseNotFound();
    await this.assertCanAuthor(user, course);
    return course;
  }
}
