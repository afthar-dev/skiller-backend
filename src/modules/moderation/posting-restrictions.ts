import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";

export const STRIKES_FOR_BAN = 3;
export const STRIKE_LIFETIME_DAYS = 90;
export const BAN_DAYS = 7;

export const postingRestricted = (until: Date) =>
  new AppError("POSTING_RESTRICTED", 403, "You cannot post reels or comments until your restriction ends", { until: until.toISOString() });

/** Whether a user is barred from posting reels and comments (three active strikes -> seven days from the third). */
@Injectable()
export class PostingRestrictions {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** When the ban ends, or null if the user may post. */
  async bannedUntil(userId: string): Promise<Date | null> {
    const row = await this.prisma.userRestriction.findUnique({ where: { userId } });
    return row && row.until.getTime() > this.clock.now().getTime() ? row.until : null;
  }

  /** 403 POSTING_RESTRICTED with `details.until` while the ban lasts. */
  async assertCanPost(userId: string): Promise<void> {
    const until = await this.bannedUntil(userId);
    if (until) throw postingRestricted(until);
  }
}
