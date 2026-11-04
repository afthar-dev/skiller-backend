import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Course } from "@prisma/client";
import type { Redis } from "ioredis";
import { REDIS } from "../../common/redis/redis.constants";
import { NotificationsService, type NotifyInput } from "../notifications";
import { PlatformRoleDirectory } from "../rbac";
import { CoursePolicy } from "./course.policy";

export const MODERATOR_FANOUT_CAP = 50;
/** An author hears about new reviews (or questions) of one course at most once per this long. */
export const ACTIVITY_NOTIFICATION_WINDOW_SEC = 10 * 60;

/** Tells a course's authors (the creator, or the owning organization's owners and instructors) about a moderation decision. Best effort: a failed notification never undoes the decision. */
@Injectable()
export class CourseNotifier {
  private readonly logger = new Logger(CourseNotifier.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly policy: CoursePolicy,
    private readonly directory: PlatformRoleDirectory,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Tells the course's authors (never `exceptUserId`, the person who did it) that learners are active: a new review or question. Batched: a Redis key
   * per (kind, course, author) lets one notification through per ACTIVITY_NOTIFICATION_WINDOW_SEC, however much happens in between. Best effort.
   */
  async notifyAuthorsOfActivity(course: Pick<Course, "id" | "ownerType" | "ownerId" | "createdById">, kind: "review" | "question", exceptUserId: string, input: Omit<NotifyInput, "data">): Promise<void> {
    try {
      const recipients = (await this.policy.authorIds(course)).filter((id) => id !== exceptUserId);
      for (const userId of recipients) {
        const key = `notify:course-${kind}:${course.id}:${userId}`;
        if ((await this.redis.set(key, "1", "EX", ACTIVITY_NOTIFICATION_WINDOW_SEC, "NX")) !== "OK") continue;
        try {
          await this.notifications.notify(userId, { ...input, data: { courseId: course.id } });
        } catch (err) {
          await this.redis.del(key).catch(() => undefined); // not told: let the next event try again
          throw err;
        }
      }
    } catch (err) {
      this.logger.error(`could not notify the authors of course ${course.id} about a ${kind}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Tells one learner about a reply or an answer. Best effort. */
  async notifyUser(userId: string, input: NotifyInput): Promise<void> {
    try {
      await this.notifications.notify(userId, input);
    } catch (err) {
      this.logger.error(`could not notify user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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
