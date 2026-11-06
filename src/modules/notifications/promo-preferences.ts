import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AccountService } from "../identity";
import { EmailSuppressions } from "../mail";

export const PROMO_TYPE = "promo";
export const MARKETING_OPT_IN_TYPE = "marketing_opt_in";

/**
 * Consent for promotional email. Two preference types: `promo` (the `email` flag is on by default: every account is subscribed until it unsubscribes) and
 * `marketing_opt_in` (off by default: explicit opt-in, which the platform setting `marketing_opt_in_required` can make mandatory). Turning `promo` off also puts
 * the address on the suppression list (reason `unsubscribed`) so every promotional path honours it, and turning it back on lifts that, and only that.
 */
@Injectable()
export class PromoPreferences {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountService,
    private readonly suppressions: EmailSuppressions,
  ) {}

  /** Of these members, who turned promotional email off and who explicitly opted in. */
  async promoStates(userIds: string[]): Promise<{ unsubscribed: Set<string>; optedIn: Set<string> }> {
    if (userIds.length === 0) return { unsubscribed: new Set(), optedIn: new Set() };
    const rows = await this.prisma.notificationPreference.findMany({ where: { userId: { in: userIds }, type: { in: [PROMO_TYPE, MARKETING_OPT_IN_TYPE] } }, select: { userId: true, type: true, email: true } });
    return {
      unsubscribed: new Set(rows.filter((r) => r.type === PROMO_TYPE && !r.email).map((r) => r.userId)),
      optedIn: new Set(rows.filter((r) => r.type === MARKETING_OPT_IN_TYPE && r.email).map((r) => r.userId)),
    };
  }

  /** Subscribes or unsubscribes the member from promotional email, with the matching suppression. Idempotent. */
  async setPromoEmail(userId: string, enabled: boolean): Promise<void> {
    await this.prisma.notificationPreference.upsert({
      where: { userId_type: { userId, type: PROMO_TYPE } },
      create: { userId, type: PROMO_TYPE, inApp: true, email: enabled },
      update: { email: enabled },
    });
    const email = await this.accounts.findEmail(userId);
    if (!email) return;
    if (enabled) await this.suppressions.releaseUnsubscribe(email);
    else await this.suppressions.addUnsubscribe(email);
  }
}
