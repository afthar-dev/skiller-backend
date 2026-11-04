import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { CoursePolicy } from "./course.policy";

/** What another module may show about a course that is open to the public. */
export interface CourseCard {
  id: string;
  slug: string;
  title: string;
  /** Paise as a decimal string. */
  pricePaise: string;
  thumbnailAssetId: string | null;
}

/**
 * Read-only questions other modules (reels today, gigs later) ask about courses without touching course tables. A course is "available" when it is
 * PUBLISHED and not flagged by a moderator: the same rule as the public course page.
 */
@Injectable()
export class CourseLookup {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: CoursePolicy,
  ) {}

  /** The course is available and `userId` is one of its authors (the creator of a USER course, an org owner / instructor of an ORG course). */
  async isLinkableBy(courseId: string, userId: string): Promise<boolean> {
    const course = await this.prisma.course.findUnique({ where: { id: courseId }, select: { ownerType: true, ownerId: true, status: true, flaggedAt: true } });
    if (!course || course.status !== "PUBLISHED" || course.flaggedAt) return false;
    return (await this.policy.authorIds(course)).includes(userId);
  }

  /** Cards of the available courses among `courseIds` (the others are simply absent). */
  async availableCards(courseIds: string[]): Promise<Map<string, CourseCard>> {
    if (courseIds.length === 0) return new Map();
    const rows = await this.prisma.course.findMany({
      where: { id: { in: courseIds }, status: "PUBLISHED", flaggedAt: null },
      select: { id: true, slug: true, title: true, pricePaise: true, thumbnailAssetId: true },
    });
    return new Map(rows.map((c) => [c.id, { id: c.id, slug: c.slug, title: c.title, pricePaise: c.pricePaise.toString(), thumbnailAssetId: c.thumbnailAssetId }]));
  }
}
