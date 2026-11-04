import { Injectable, Logger } from "@nestjs/common";
import type { Course } from "@prisma/client";
import { NotificationsService, type NotifyInput } from "../notifications";
import { CoursePolicy } from "./course.policy";

/** Tells a course's authors (the creator, or the owning organization's owners and instructors) about a moderation decision. Best effort: a failed notification never undoes the decision. */
@Injectable()
export class CourseNotifier {
  private readonly logger = new Logger(CourseNotifier.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly policy: CoursePolicy,
  ) {}

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
