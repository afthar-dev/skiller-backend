import { Injectable } from "@nestjs/common";
import type { Order, OrderItem, Prisma } from "@prisma/client";
import type { Paise } from "./money";

export interface SellableDescription {
  title: string;
  /** Current list price in paise (the server's price; a client-sent amount is never used). */
  pricePaise: Paise;
  sellerOwnerType: "USER" | "ORG";
  sellerOwnerId: string;
  purchasable: boolean;
  /** Why it cannot be bought (already owned, unpublished, ...); shown to the buyer. */
  reason?: string;
}

export type PaidOrder = Order & { items: OrderItem[] };

/**
 * Something the platform sells (a course, later a gig package). The module that owns the thing implements this and registers
 * it; billing never learns what a "course" is. `describe` throws an AppError (404) for an unknown item.
 */
export interface SellableProvider {
  readonly type: string;
  /** `buyerId` lets the provider refuse a purchase the buyer already made. */
  describe(itemId: string, ctx: { buyerId: string }): Promise<SellableDescription>;
  /** Runs inside the fulfilment transaction: grant access here. Throwing rolls the whole payment back (it is retried). */
  onPaid(tx: Prisma.TransactionClient, order: PaidOrder): Promise<void>;
  /** Runs inside the refund transaction: revoke access here. */
  onRefunded(tx: Prisma.TransactionClient, order: PaidOrder): Promise<void>;
}

@Injectable()
export class SellableRegistry {
  private readonly providers = new Map<string, SellableProvider>();

  register(provider: SellableProvider): void {
    if (this.providers.has(provider.type)) throw new Error(`a sellable provider for ${provider.type} is already registered`);
    this.providers.set(provider.type, provider);
  }

  /** undefined for an unregistered type: callers decide whether that is a 4xx (checkout) or a fault (fulfilment). */
  find(type: string): SellableProvider | undefined {
    return this.providers.get(type);
  }

  types(): string[] {
    return [...this.providers.keys()];
  }
}
