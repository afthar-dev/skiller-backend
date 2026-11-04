import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit";
import { firstFreeSlug, randomSlug, slugify } from "./course-rules";
import { toCategoryView, type CategoryView } from "./course-view";

export interface CategoryMeta {
  actorId: string;
  ip?: string;
  requestId?: string;
}

/** The starter set seeded on every deploy (upsert by slug, so admin edits to name / position / active are never overwritten). */
export const STARTER_CATEGORIES = [
  "Development",
  "Data Science",
  "Design",
  "Business",
  "Marketing",
  "Finance & Accounting",
  "Personal Development",
  "Photography & Video",
  "Music",
  "Health & Fitness",
  "Teaching & Academics",
  "IT & Software",
  "Languages",
  "Lifestyle",
  "Exam Preparation",
] as const;

export async function seedCategories(prisma: Pick<PrismaService, "category">): Promise<void> {
  for (const [position, name] of STARTER_CATEGORIES.entries()) {
    const slug = slugify(name);
    await prisma.category.upsert({ where: { slug }, create: { slug, name, position: position + 1 }, update: {} });
  }
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listActive(): Promise<{ items: CategoryView[] }> {
    const rows = await this.prisma.category.findMany({ where: { isActive: true }, orderBy: [{ position: "asc" }, { name: "asc" }] });
    return { items: rows.map(toCategoryView) };
  }

  async listAll(): Promise<{ items: CategoryView[] }> {
    const rows = await this.prisma.category.findMany({ orderBy: [{ position: "asc" }, { name: "asc" }] });
    return { items: rows.map(toCategoryView) };
  }

  async create(input: { name: string; position?: number; isActive?: boolean }, meta: CategoryMeta): Promise<CategoryView> {
    const base = slugify(input.name) || randomSlug("category");
    for (let attempt = 0; ; attempt++) {
      const taken = new Set((await this.prisma.category.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map((c) => c.slug));
      const slug = attempt < 3 ? firstFreeSlug(base, taken) : randomSlug(base);
      try {
        return await this.prisma.$transaction(async (tx) => {
          const max = await tx.category.aggregate({ _max: { position: true } });
          const row = await tx.category.create({ data: { slug, name: input.name, position: input.position ?? (max._max.position ?? 0) + 1, isActive: input.isActive ?? true } });
          await this.audit.record(tx, { actorId: meta.actorId, action: "course.category.created", targetType: "category", targetId: row.id, after: toCategoryView(row), ip: meta.ip, requestId: meta.requestId });
          return toCategoryView(row);
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") || attempt >= 6) throw err;
      }
    }
  }

  async update(id: string, patch: { name?: string; position?: number; isActive?: boolean }, meta: CategoryMeta): Promise<CategoryView> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.category.findUnique({ where: { id } });
      if (!before) throw notFound();
      const row = await tx.category.update({ where: { id }, data: patch });
      await this.audit.record(tx, { actorId: meta.actorId, action: "course.category.updated", targetType: "category", targetId: id, before: toCategoryView(before), after: toCategoryView(row), ip: meta.ip, requestId: meta.requestId });
      return toCategoryView(row);
    });
  }

  async remove(id: string, meta: CategoryMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.category.findUnique({ where: { id } });
      if (!before) throw notFound();
      if ((await tx.course.count({ where: { categoryId: id } })) > 0) {
        throw new AppError("CATEGORY_IN_USE", 409, "Courses use this category; deactivate it instead of deleting it");
      }
      await tx.category.delete({ where: { id } });
      await this.audit.record(tx, { actorId: meta.actorId, action: "course.category.deleted", targetType: "category", targetId: id, before: toCategoryView(before), ip: meta.ip, requestId: meta.requestId });
    });
  }
}

const notFound = () => new AppError("CATEGORY_NOT_FOUND", 404, "Category not found");
