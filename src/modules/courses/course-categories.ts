import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";

/** Which category a course is in. Needs nothing but the database, so the worker process can use it (interest keys are built from it). */
@Injectable()
export class CourseCategories {
  constructor(private readonly prisma: PrismaService) {}

  /** The category of each of these courses; unknown ids are absent. Availability does not matter: the link was valid when it was made. */
  async ofCourses(courseIds: string[]): Promise<Map<string, string>> {
    if (courseIds.length === 0) return new Map();
    const rows = await this.prisma.course.findMany({ where: { id: { in: courseIds } }, select: { id: true, categoryId: true } });
    return new Map(rows.map((c) => [c.id, c.categoryId]));
  }
}
