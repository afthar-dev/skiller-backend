import { Injectable } from "@nestjs/common";
import { AccountService } from "../identity";
import { EmailSuppressions } from "../mail";
import { PromoPreferences } from "../notifications";
import { UnsubscribeTokens } from "./unsubscribe-token";

/** Unsubscribing from promotional email. The answers carry no address and no member id: the link is the only thing the caller proves. */
@Injectable()
export class UnsubscribeService {
  constructor(
    private readonly tokens: UnsubscribeTokens,
    private readonly preferences: PromoPreferences,
    private readonly accounts: AccountService,
    private readonly suppressions: EmailSuppressions,
  ) {}

  async describe(token: unknown): Promise<{ category: "promotional"; alreadyUnsubscribed: boolean }> {
    const { userId, category } = this.tokens.verify(token);
    const email = await this.accounts.findEmail(userId);
    const suppressed = email ? (await this.suppressions.find([email])).has(email.toLowerCase()) : false;
    const states = await this.preferences.promoStates([userId]);
    return { category, alreadyUnsubscribed: suppressed || states.unsubscribed.has(userId) };
  }

  /**
   * Turns the member's promo preference off and puts their address on the suppression list (reason `unsubscribed`; a bounce already there is kept), so
   * every promotional path honours it, preference row or not. A link for a member who no longer exists is accepted and does nothing.
   */
  async apply(token: unknown): Promise<{ unsubscribed: true; category: "promotional" }> {
    const { userId, category } = this.tokens.verify(token);
    await this.preferences.setPromoEmail(userId, false);
    return { unsubscribed: true, category };
  }
}
