import { Inject, Injectable } from "@nestjs/common";
import type { Lesson } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { MediaService, ObjectStorage } from "../media";
import { CourseAccessRules } from "./course-access-rules";
import { CourseThumbnails } from "./course-thumbnails";
import { courseNotFound } from "./course.policy";
import { denied } from "./learn-errors";

/** Resource downloads are presigned for this long. */
export const RESOURCE_URL_TTL_SEC = 300;

/** The player's side of courses: the curriculum with my progress, and the content of a lesson I may open. */
@Injectable()
export class LearnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: CourseAccessRules,
    private readonly media: MediaService,
    private readonly storage: ObjectStorage,
    private readonly thumbnails: CourseThumbnails,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async course(userId: string, slug: string) {
    const course = await this.prisma.course.findUnique({ where: { slug } });
    if (!course) throw courseNotFound();
    const access = await this.rules.learnAccess(userId, course);
    if (!access) throw denied(course);

    // Progress belongs to the enrolment: an author or moderator (no enrolment) sees none.
    const mine = access.via === "ENROLLED";
    const [sections, progress, enrolment] = await Promise.all([
      this.prisma.courseSection.findMany({ where: { courseId: course.id }, orderBy: { position: "asc" }, include: { lessons: { orderBy: { position: "asc" } } } }),
      mine ? this.prisma.lessonProgress.findMany({ where: { userId, courseId: course.id } }) : Promise.resolve([]),
      mine ? this.prisma.enrolment.findFirst({ where: { userId, courseId: course.id, revokedAt: null } }) : Promise.resolve(null),
    ]);
    const byLesson = new Map(progress.map((p) => [p.lessonId, p]));
    const { thumbnailUrl } = await this.thumbnails.withUrl(course);
    return {
      course: {
        id: course.id,
        slug: course.slug,
        title: course.title,
        status: course.status,
        flagged: course.flaggedAt !== null,
        progressPct: enrolment?.progressPct ?? 0,
        completedAt: enrolment?.completedAt?.toISOString() ?? null,
        thumbnailUrl,
      },
      access: access.via,
      sections: sections.map((s) => ({
        id: s.id,
        title: s.title,
        position: s.position,
        lessons: s.lessons.map((l) => ({
          id: l.id,
          title: l.title,
          type: l.type,
          position: l.position,
          durationSec: l.durationSec,
          isFreePreview: l.isFreePreview,
          isRequired: l.isRequired,
          completed: byLesson.get(l.id)?.completedAt != null,
          positionSec: byLesson.get(l.id)?.positionSec ?? 0,
        })),
      })),
    };
  }

  /** `userId` is null for a signed-out visitor, who may open free-preview lessons only (the same refusals as any non-enrolled user otherwise). */
  async lesson(userId: string | null, lessonId: string) {
    const lesson = await this.prisma.lesson.findUnique({ where: { id: lessonId }, include: { course: true } });
    if (!lesson) throw new AppError("LESSON_NOT_FOUND", 404, "Lesson not found");
    const access = userId ? await this.rules.learnAccess(userId, lesson.course, lesson) : this.rules.anonymousLearnAccess(lesson.course, lesson);
    if (!access) throw denied(lesson.course);

    const progress = userId && access.progress ? await this.prisma.lessonProgress.findUnique({ where: { userId_lessonId: { userId, lessonId } } }) : null;
    return {
      id: lesson.id,
      courseId: lesson.courseId,
      courseSlug: lesson.course.slug,
      sectionId: lesson.sectionId,
      title: lesson.title,
      type: lesson.type,
      position: lesson.position,
      durationSec: lesson.durationSec,
      isFreePreview: lesson.isFreePreview,
      isRequired: lesson.isRequired,
      articleBody: lesson.type === "ARTICLE" ? lesson.articleBody : null,
      videoAssetId: lesson.type === "VIDEO" ? lesson.videoAssetId : null,
      quizId: lesson.type === "QUIZ" ? lesson.quizId : null,
      resource: lesson.type === "RESOURCE" ? await this.resource(lesson) : null,
      access: access.via,
      canTrackProgress: access.progress,
      progress: { positionSec: progress?.positionSec ?? 0, completed: progress?.completedAt != null },
    };
  }

  private async resource(lesson: Pick<Lesson, "resourceAssetId">) {
    const file = lesson.resourceAssetId ? await this.media.privateFile(lesson.resourceAssetId) : null;
    if (!file) return null;
    return {
      url: await this.storage.presignPrivateGet(file.objectKey, { expiresInSec: RESOURCE_URL_TTL_SEC, filename: file.filename ?? undefined }),
      filename: file.filename,
      expiresAt: new Date(this.clock.now().getTime() + RESOURCE_URL_TTL_SEC * 1000).toISOString(),
    };
  }
}
