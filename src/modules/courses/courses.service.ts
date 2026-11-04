import { Injectable } from "@nestjs/common";
import { Prisma, type Course, type CourseLevel, type CourseOwnerType } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { CourseMedia } from "./course-media";
import { lockCourse } from "./course-lock";
import { sanitizeMarkdown } from "./markdown-sanitizer";
import { assertValidCoursePrice, firstFreeSlug, randomSlug, slugify } from "./course-rules";
import { toCourseView, type CourseView } from "./course-view";
import { CoursePolicy } from "./course.policy";

export interface CreateCourseInput {
  ownerType: CourseOwnerType;
  orgId?: string;
  title: string;
  subtitle?: string | null;
  description: string;
  categoryId: string;
  level: CourseLevel;
  language: string;
  tags: string[];
  pricePaise: bigint;
}

export interface UpdateCourseInput {
  title?: string;
  subtitle?: string | null;
  description?: string;
  categoryId?: string;
  level?: CourseLevel;
  language?: string;
  tags?: string[];
  pricePaise?: bigint;
  slug?: string;
  thumbnailAssetId?: string | null;
  promoVideoAssetId?: string | null;
}

const isUniqueViolation = (err: unknown, field: string) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && String((err.meta?.target as string[] | string | undefined) ?? "").includes(field);

@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: CoursePolicy,
    private readonly media: CourseMedia,
  ) {}

  async create(user: { id: string }, input: CreateCourseInput): Promise<CourseView> {
    const ownerId = input.ownerType === "ORG" ? (input.orgId as string) : user.id;
    await this.policy.assertCanCreateFor(user, input.ownerType, ownerId);
    assertValidCoursePrice(input.pricePaise);
    await this.assertCategory(input.categoryId);

    const base = slugify(input.title) || randomSlug("course");
    for (let attempt = 0; ; attempt++) {
      const slug = await this.freeSlug(base, attempt);
      try {
        const course = await this.prisma.course.create({
          data: {
            ownerType: input.ownerType,
            ownerId,
            slug,
            title: input.title,
            subtitle: input.subtitle ?? null,
            description: sanitizeMarkdown(input.description),
            categoryId: input.categoryId,
            level: input.level,
            language: input.language,
            tags: input.tags,
            pricePaise: input.pricePaise,
            createdById: user.id,
          },
        });
        return toCourseView(course);
      } catch (err) {
        if (!isUniqueViolation(err, "slug") || attempt >= 6) throw err;
      }
    }
  }

  /** Courses the user owns plus those of the organizations they author for, newest first. */
  async list(user: { id: string }, page: PageQuery, status?: Course["status"]) {
    const orgIds = await this.policy.authoredOrgIds(user.id);
    const rows = await this.prisma.course.findMany({
      where: {
        OR: [{ ownerType: "USER", ownerId: user.id }, ...(orgIds.length > 0 ? [{ ownerType: "ORG" as const, ownerId: { in: orgIds } }] : [])],
        ...(status ? { status } : {}),
        ...(page.cursor ? { id: { lt: page.cursor } } : {}),
      },
      orderBy: { id: "desc" },
      take: page.limit + 1,
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    return { items: items.map(toCourseView), nextCursor };
  }

  async get(user: { id: string }, id: string): Promise<CourseView> {
    return toCourseView(await this.policy.loadForAuthor(user, id));
  }

  async update(user: { id: string }, id: string, patch: UpdateCourseInput): Promise<CourseView> {
    await this.policy.loadForAuthor(user, id);
    if (patch.pricePaise !== undefined) assertValidCoursePrice(patch.pricePaise);
    if (patch.categoryId !== undefined) await this.assertCategory(patch.categoryId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockCourse(tx, id);
        const course = await tx.course.findUniqueOrThrow({ where: { id } });
        const data: Prisma.CourseUpdateInput = {};
        if (patch.title !== undefined) data.title = patch.title;
        if (patch.subtitle !== undefined) data.subtitle = patch.subtitle;
        if (patch.description !== undefined) data.description = sanitizeMarkdown(patch.description);
        if (patch.categoryId !== undefined) data.category = { connect: { id: patch.categoryId } };
        if (patch.level !== undefined) data.level = patch.level;
        if (patch.language !== undefined) data.language = patch.language;
        if (patch.tags !== undefined) data.tags = patch.tags;
        if (patch.pricePaise !== undefined) data.pricePaise = patch.pricePaise;
        if (patch.slug !== undefined && patch.slug !== course.slug) {
          if (course.slugLockedAt) throw new AppError("COURSE_SLUG_LOCKED", 409, "The address of a published course cannot change");
          data.slug = patch.slug;
        }
        if (patch.thumbnailAssetId !== undefined && patch.thumbnailAssetId !== course.thumbnailAssetId) {
          if (patch.thumbnailAssetId) await this.media.attach(tx, course, patch.thumbnailAssetId, "THUMBNAIL");
          if (course.thumbnailAssetId) await this.media.detach(tx, course.thumbnailAssetId);
          data.thumbnailAssetId = patch.thumbnailAssetId;
        }
        if (patch.promoVideoAssetId !== undefined && patch.promoVideoAssetId !== course.promoVideoAssetId) {
          if (patch.promoVideoAssetId) await this.media.attach(tx, course, patch.promoVideoAssetId, "REEL");
          if (course.promoVideoAssetId) await this.media.detach(tx, course.promoVideoAssetId);
          data.promoVideoAssetId = patch.promoVideoAssetId;
        }
        return toCourseView(await tx.course.update({ where: { id }, data }));
      });
    } catch (err) {
      if (isUniqueViolation(err, "slug")) throw new AppError("COURSE_SLUG_TAKEN", 409, "This course address is already in use");
      throw err;
    }
  }

  /** Only a draft that was never published; its media is released with it. */
  async remove(user: { id: string }, id: string): Promise<void> {
    await this.policy.loadForAuthor(user, id);
    await this.prisma.$transaction(async (tx) => {
      await lockCourse(tx, id);
      const course = await tx.course.findUnique({ where: { id } });
      if (!course) return;
      if (course.status !== "DRAFT" || course.slugLockedAt || course.publishedAt) {
        throw new AppError("COURSE_NOT_DELETABLE", 409, "Only a draft that was never published can be deleted; archive the course instead");
      }
      for (const assetId of await this.assetIdsOf(tx, course)) await this.media.detach(tx, assetId);
      await tx.course.delete({ where: { id } });
    });
  }

  /** Every media asset a course holds: thumbnail, promo, lesson videos and resource files. */
  private async assetIdsOf(tx: Prisma.TransactionClient, course: Course): Promise<string[]> {
    const lessons = await tx.lesson.findMany({ where: { courseId: course.id }, select: { videoAssetId: true, resourceAssetId: true } });
    return [course.thumbnailAssetId, course.promoVideoAssetId, ...lessons.flatMap((l) => [l.videoAssetId, l.resourceAssetId])].filter((x): x is string => x !== null);
  }

  private async assertCategory(categoryId: string): Promise<void> {
    const found = await this.prisma.category.findFirst({ where: { id: categoryId, isActive: true }, select: { id: true } });
    if (!found) throw new AppError("CATEGORY_INVALID", 422, "Choose an existing, active category");
  }

  private async freeSlug(base: string, attempt: number): Promise<string> {
    if (attempt >= 3) return randomSlug(base.slice(0, 50));
    const taken = new Set((await this.prisma.course.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map((c) => c.slug));
    return firstFreeSlug(base, taken);
  }
}
