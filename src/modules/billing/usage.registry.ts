import { Injectable } from "@nestjs/common";
import type { Owner } from "./entitlements.service";
import type { LimitKey } from "./plan-catalog";

export type UsageProvider = (owner: Owner) => Promise<number | null>;

/**
 * Billing must not read other modules' tables, so the module that owns a resource reports its usage here (media: storage in
 * bytes, organizations: seats). "My subscription" shows whatever has a provider; limits without one report null.
 */
@Injectable()
export class UsageRegistry {
  private readonly providers = new Map<LimitKey, UsageProvider>();

  register(key: LimitKey, provider: UsageProvider): void {
    this.providers.set(key, provider);
  }

  async usage(owner: Owner, key: LimitKey): Promise<number | null> {
    const provider = this.providers.get(key);
    return provider ? provider(owner) : null;
  }
}
