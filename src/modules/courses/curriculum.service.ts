import { Injectable } from "@nestjs/common";
import { Prisma, type Lesson, type LessonType } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { CourseMedia } from "./course-media";
import { lockCourseForEdit } from "./course-lock";
import { CoursePolicy } from "./course.policy";
import { assertSafeMarkdown } from "./markdown";

export const MAX_SECTIONS_PER_COURSE = 50;
export const MAX_LESSONS_PER_COURSE = 500;

export interface LessonView {
  id: string;
  sectionId: string;
  title: string;
  type: LessonType;
  position: number;
  isFreePreview: boolean;
  isRequired: boolean;
  videoAssetId: string | null;
  durationSec: number | null;
  articleBody: string | null;
  resourceAssetId: string | null;
  quizId: string | null;
}

export interface SectionView {
  id: string;
  title: string;
  position: number;
  lessons: LessonView[];
}

export interface CreateLessonInput {
  sectionId: string;
  title: string;
  type: LessonType;
  isFreePreview?: boolean;
  isRequired?: boolean;
  videoAssetId?: string;
  articleBody?: string;
  resourceAssetId?: string;
}

export interface UpdateLessonInput {
  title?: string;
  isFreePreview?: boolean;
  isRequired?: boolean;
  videoAssetId?: string | null;
  articleBody?: string | null;
  resourceAssetId?: string | null;
}

export interface OrderInput {
  sections: Array<{ id: string; lessonIds: string[] }>;
}

const toLessonView = (l: Lesson): LessonView => ({
  id: l.id,
  sectionId: l.sectionId,
  title: l.title,
  type: l.type,
  position: l.position,
  isFreePreview: l.isFreePreview,
  isRequired: l.isRequired,
  videoAssetId: l.videoAssetId,
  durationSec: l.durationSec,
  articleBody: l.articleBody,
  resourceAssetId: l.resourceAssetId,
  quizId: l.quizId,
});

const sectionNotFound = () => new AppError("SECTION_NOT_FOUND", 404, "Section not found");
const lessonNotFound = () => new AppError("LESSON_NOT_FOUND", 404, "Lesson not found");
const wrongField = (field: string, type: LessonType) => new AppError("VALIDATION_FAILED", 400, "Request validation failed", { fields: { [field]: [`not applicable to a ${type} lesson`] } });

@Injectable()
export class CurriculumService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: CoursePolicy,
    private readonly media: CourseMedia,
  ) {}

  async authorView(user: { id: string }, courseId: string): Promise<{ sections: SectionView[] }> {
    await this.policy.loadForRead(user, courseId);
    return { sections: await this.read(this.prisma, courseId) };
  }

  async createSection(user: { id: string }, courseId: string, input: { title: string }): Promise<SectionView> {
    await this.policy.loadForAuthor(user, courseId);
    return this.prisma.$transaction(async (tx) => {
      await lockCourseForEdit(tx, courseId);
      const count = await tx.courseSection.count({ where: { courseId } });
      if (count >= MAX_SECTIONS_PER_COURSE) throw limit("sections", MAX_SECTIONS_PER_COURSE);
      const row = await tx.courseSection.create({ data: { courseId, title: input.title, position: count } });
      return { id: row.id, title: row.title, position: row.position, lessons: [] };
    });
  }

  async updateSection(user: { id: string }, courseId: string, sectionId: string, input: { title: string }): Promise<SectionView> {
    await this.policy.loadForAuthor(user, courseId);
    return this.prisma.$transaction(async (tx) => {
      await lockCourseForEdit(tx, courseId);
      const section = await tx.courseSection.findFirst({ where: { id: sectionId, courseId } });
      if (!section) throw sectionNotFound();
      const row = await tx.courseSection.update({ where: { id: sectionId }, data: { title: input.title }, include: { lessons: { orderBy: { position: "asc" } } } });
      return { id: row.id, title: row.title, position: row.position, lessons: row.lessons.map(toLessonView) };
    });
  }

  async deleteSection(user: { id: string }, courseId: string, sectionId: string): Promise<void> {
    await this.policy.loadForAuthor(user, courseId);
    await this.prisma.$transaction(async (tx) => {
      await lockCourseForEdit(tx, courseId);
      const section = await tx.courseSection.findFirst({ where: { id: sectionId, courseId }, include: { lessons: true } });
      if (!section) throw sectionNotFound();
      for (const lesson of section.lessons) await this.releaseLessonMedia(tx, lesson);
      await tx.courseSection.delete({ where: { id: sectionId } });
      await tx.courseSection.updateMany({ where: { courseId, position: { gt: section.position } }, data: { position: { decrement: 1 } } });
    });
  }

  async createLesson(user: { id: string }, courseId: string, input: CreateLessonInput): Promise<LessonView> {
    const course = await this.policy.loadForAuthor(user, courseId);
    assertFieldsMatchType(input.type, input);
    return this.prisma.$transaction(async (tx) => {
      await lockCourseForEdit(tx, courseId);
      const section = await tx.courseSection.findFirst({ where: { id: input.sectionId, courseId } });
      if (!section) throw sectionNotFound();
      if ((await tx.lesson.count({ where: { courseId } })) >= MAX_LESSONS_PER_COURSE) throw limit("lessons", MAX_LESSONS_PER_COURSE);
      const position = await tx.lesson.count({ where: { sectionId: input.sectionId } });

      let durationSec: number | null = null;
      if (input.videoAssetId) durationSec = (await this.media.attach(tx, course, input.videoAssetId, "COURSE_LESSON")).durationSec;
      if (input.resourceAssetId) await this.media.attach(tx, course, input.resourceAssetId, "COURSE_RESOURCE");

      const row = await tx.lesson.create({
        data: {
          courseId,
          sectionId: input.sectionId,
          title: input.title,
          type: input.type,
          position,
          isFreePreview: input.isFreePreview ?? false,
          isRequired: input.isRequired ?? true,
          videoAssetId: input.videoAssetId ?? null,
          durationSec,
          articleBody: input.articleBody === undefined ? null : assertSafeMarkdown(input.articleBody),
          resourceAssetId: input.resourceAssetId ?? null,
        },
      });
      return toLessonView(row);
    });
  }

  async updateLesson(user: { id: string }, courseId: string, lessonId: string, patch: UpdateLessonInput): Promise<LessonView> {
    const course = await this.policy.loadForAuthor(user, courseId);
    return this.prisma.$transaction(async (tx) => {
      await lockCourseForEdit(tx, courseId);
      const lesson = await tx.lesson.findFirst({ where: { id: lessonId, courseId } });
      if (!lesson) throw lessonNotFound();
      assertFieldsMatchType(lesson.type, patch);

      const data: Prisma.LessonUpdateInput = {};
      if (patch.title !== undefined) data.title = patch.title;
      if (patch.isFreePreview !== undefined) data.isFreePreview = patch.isFreePreview;
      if (patch.isRequired !== undefined) data.isRequired = patch.isRequired;
      if (patch.articleBody !== undefined) data.articleBody = patch.articleBody === null ? null : assertSafeMarkdown(patch.articleBody);
      if (patch.videoAssetId !== undefined && patch.videoAssetId !== lesson.videoAssetId) {
        data.durationSec = patch.videoAssetId ? (await this.media.attach(tx, course, patch.videoAssetId, "COURSE_LESSON")).durationSec : null;
        if (lesson.videoAssetId) await this.media.detach(tx, lesson.videoAssetId);
        data.videoAssetId = patch.videoAssetId;
      }
      if (patch.resourceAssetId !== undefined && patch.resourceAssetId !== lesson.resourceAssetId) {
        if (patch.resourceAssetId) await this.media.attach(tx, course, patch.resourceAssetId, "COURSE_RESOURCE");
        if (lesson.resourceAssetId) await this.media.detach(tx, lesson.resourceAssetId);
        data.resourceAssetId = patch.resourceAssetId;
      }
      return toLessonView(await tx.lesson.update({ where: { id: lessonId }, data }));
    });
  }

  async deleteLesson(user: { id: string }, courseId: string, lessonId: string): Promise<void> {
    await this.policy.loadForAuthor(user, courseId);
    await this.prisma.$transaction(async (tx) => {
      await lockCourseForEdit(tx, courseId);
      const lesson = await tx.lesson.findFirst({ where: { id: lessonId, courseId } });
      if (!lesson) throw lessonNotFound();
      await this.releaseLessonMedia(tx, lesson);
      await tx.lesson.delete({ where: { id: lessonId } });
      await tx.lesson.updateMany({ where: { sectionId: lesson.sectionId, position: { gt: lesson.position } }, data: { position: { decrement: 1 } } });
    });
  }

  /**
   * The whole structure in one call: every section of the course exactly once, every lesson exactly once, each under the section it
   * should end up in. Anything else is rejected with nothing changed. Positions are rewritten as dense 0..n.
   */
  async reorder(user: { id: string }, courseId: string, order: OrderInput): Promise<{ sections: SectionView[] }> {
    await this.policy.loadForAuthor(user, courseId);
    return this.prisma.$transaction(async (tx) => {
      await lockCourseForEdit(tx, courseId);
      const [sections, lessons] = await Promise.all([
        tx.courseSection.findMany({ where: { courseId }, select: { id: true } }),
        tx.lesson.findMany({ where: { courseId }, select: { id: true } }),
      ]);
      const sectionIds = order.sections.map((s) => s.id);
      const lessonIds = order.sections.flatMap((s) => s.lessonIds);
      assertPermutation("sections", sectionIds, sections.map((s) => s.id));
      assertPermutation("lessons", lessonIds, lessons.map((l) => l.id));

      if (sectionIds.length > 0) {
        const rows = sectionIds.map((id, position) => Prisma.sql`(${id}::text, ${position}::int)`);
        await tx.$executeRaw`UPDATE "course_sections" AS s SET "position" = v.pos, "updatedAt" = now() FROM (VALUES ${Prisma.join(rows)}) AS v(id, pos) WHERE s."id" = v.id`;
      }
      if (lessonIds.length > 0) {
        const rows = order.sections.flatMap((s) => s.lessonIds.map((id, position) => Prisma.sql`(${id}::text, ${s.id}::text, ${position}::int)`));
        await tx.$executeRaw`UPDATE "lessons" AS l SET "sectionId" = v.sid, "position" = v.pos, "updatedAt" = now() FROM (VALUES ${Prisma.join(rows)}) AS v(id, sid, pos) WHERE l."id" = v.id`;
      }
      return { sections: await this.read(tx, courseId) };
    });
  }

  /** Public curriculum of a published, unflagged course: titles, durations and free-preview flags. Only free-preview videos expose their asset id. */
  async publicView(slug: string) {
    const course = await this.prisma.course.findUnique({ where: { slug }, select: { id: true, slug: true, title: true, status: true, flaggedAt: true } });
    if (!course || course.status !== "PUBLISHED" || course.flaggedAt) throw new AppError("COURSE_NOT_FOUND", 404, "Course not found");
    const sections = await this.read(this.prisma, course.id);
    let lessonCount = 0;
    let total = 0;
    const out = sections.map((s) => {
      const duration = s.lessons.reduce((sum, l) => sum + (l.durationSec ?? 0), 0);
      lessonCount += s.lessons.length;
      total += duration;
      return {
        id: s.id,
        title: s.title,
        position: s.position,
        durationSec: duration,
        lessons: s.lessons.map((l) => ({
          id: l.id,
          title: l.title,
          type: l.type,
          position: l.position,
          durationSec: l.durationSec,
          isFreePreview: l.isFreePreview,
          ...(l.isFreePreview && l.type === "VIDEO" && l.videoAssetId ? { videoAssetId: l.videoAssetId } : {}),
        })),
      };
    });
    return { course: { id: course.id, slug: course.slug, title: course.title }, sections: out, totals: { sections: out.length, lessons: lessonCount, durationSec: total } };
  }

  private async read(db: Prisma.TransactionClient | PrismaService, courseId: string): Promise<SectionView[]> {
    const rows = await db.courseSection.findMany({ where: { courseId }, orderBy: { position: "asc" }, include: { lessons: { orderBy: { position: "asc" } } } });
    return rows.map((s) => ({ id: s.id, title: s.title, position: s.position, lessons: s.lessons.map(toLessonView) }));
  }

  private async releaseLessonMedia(tx: Prisma.TransactionClient, lesson: Pick<Lesson, "videoAssetId" | "resourceAssetId">): Promise<void> {
    if (lesson.videoAssetId) await this.media.detach(tx, lesson.videoAssetId);
    if (lesson.resourceAssetId) await this.media.detach(tx, lesson.resourceAssetId);
  }
}

const limit = (what: string, max: number) => new AppError("CURRICULUM_LIMIT", 422, `A course can have at most ${max} ${what}`, { max });

/** Each lesson field belongs to one lesson type; sending it for another type is a client bug, not silently dropped. */
function assertFieldsMatchType(type: LessonType, input: { videoAssetId?: string | null; articleBody?: string | null; resourceAssetId?: string | null }): void {
  if (input.videoAssetId !== undefined && type !== "VIDEO") throw wrongField("videoAssetId", type);
  if (input.articleBody !== undefined && type !== "ARTICLE") throw wrongField("articleBody", type);
  if (input.resourceAssetId !== undefined && type !== "RESOURCE") throw wrongField("resourceAssetId", type);
}

function assertPermutation(what: string, given: string[], existing: string[]): void {
  const givenSet = new Set(given);
  const existingSet = new Set(existing);
  const duplicates = given.filter((id, i) => given.indexOf(id) !== i);
  const missing = existing.filter((id) => !givenSet.has(id));
  const unknown = given.filter((id) => !existingSet.has(id));
  if (duplicates.length + missing.length + unknown.length > 0) {
    throw new AppError("ORDER_INVALID", 422, `The order must list every existing ${what} exactly once`, { [what]: { duplicates: [...new Set(duplicates)], missing, unknown } });
  }
}
