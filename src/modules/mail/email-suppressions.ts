import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";

export const UNSUBSCRIBED = "unsubscribed";

const norm = (email: string) => email.trim().toLowerCase();

/** The suppression list for other modules: addresses that never get promotional mail (bounced, complained, unsubscribed). */
@Injectable()
export class EmailSuppressions {
  constructor(private readonly prisma: PrismaService) {}

  /** Which of these addresses are suppressed, and why. Keys are lower-case. */
  async find(emails: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(emails.map(norm))];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.emailSuppression.findMany({ where: { email: { in: unique } }, select: { email: true, reason: true } });
    return new Map(rows.map((r) => [r.email, r.reason]));
  }

  /** Records an unsubscribe. A bounce or complaint already on file is kept (it blocks more than an unsubscribe does). Idempotent. */
  async addUnsubscribe(email: string): Promise<void> {
    await this.prisma.emailSuppression.createMany({ data: [{ email: norm(email), reason: UNSUBSCRIBED }], skipDuplicates: true });
  }

  /** The member subscribed again: lifts an unsubscribe, and only an unsubscribe (a bounce or complaint stays). */
  async releaseUnsubscribe(email: string): Promise<void> {
    await this.prisma.emailSuppression.deleteMany({ where: { email: norm(email), reason: UNSUBSCRIBED } });
  }
}
