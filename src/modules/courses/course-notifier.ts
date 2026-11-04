import { Injectable, Logger } from "@nestjs/common";
import type { Course } from "@prisma/client";
import { NotificationsService, type NotifyInput } from "../notifications";
import { PlatformRoleDirectory } from "../rbac";
import { CoursePolicy } from "./course.policy";

export const MODERATOR_FANOUT_CAP = 50;

/** Tells a course's authors (the creator, or the owning organization's owners and instructors) about a moderation decision. Best effort: a failed notification never undoes the decision. */
@Injectable()
export class CourseNotifier {
  private readonly logger = new Logger(CourseNotifier.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly policy: CoursePolicy,
    private readonly directory: PlatformRoleDirectory,
  ) {}

  /** Tells the holders of `course.review` (at most MODERATOR_FANOUT_CAP, never the submitter) that a course waits in the queue. */
  async notifyModerators(course: Pick<Course, "id" | "title">, submitterId: string): Promise<void> {
    try {
      const ids = await this.directory.userIdsWithPermission("course.review", MODERATOR_FANOUT_CAP + 1);
      for (const userId of ids.filter((id) => id !== submitterId).slice(0, MODERATOR_FANOUT_CAP)) {
        await this.notifications.notify(userId, { type: "course.submitted", title: "A course is waiting for review", body: `${course.title} was submitted for review.`, link: "/admin/courses/review-queue", data: { courseId: course.id } });
      }
    } catch (err) {
      this.logger.error(`could not notify moderators of course ${course.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async notifyAuthors(course: Pick<Course, "id" | "ownerType" | "ownerId" | "createdById">, input: Omit<NotifyInput, "data">): Promise<void> {
    try {
      const recipients = new Set(await this.policy.authorIds(course));
      for (const userId of recipients) {
        await this.notifications.notify(userId, { ...input, data: { courseId: course.id } });
      }
    } catch (err) {
      this.logger.error(`could not notify the authors of course ${course.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
