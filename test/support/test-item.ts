import { Injectable, OnModuleInit } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AppError } from "../../src/common/errors/app-error";
import { SellableRegistry, type PaidOrder, type SellableDescription, type SellableProvider } from "../../src/modules/billing";

export interface TestItem {
  title: string;
  pricePaise: bigint;
  sellerOwnerType: "USER" | "ORG";
  sellerOwnerId: string;
  purchasable: boolean;
  reason?: string;
}

/**
 * Test-only sellable. Register it by passing `{ providers: [TestItemProvider] }` as the extra module metadata of createAuthTestApp:
 * production code never registers a TEST_ITEM. State is module-level (one jest suite = one module registry).
 */
export const testItems = new Map<string, TestItem>();
export const testState = { owned: new Set<string>(), paid: [] as string[], refunded: [] as string[], failOnPaid: null as Error | null, writeMarkerBeforeFail: false };

export function createTestItem(item: Partial<TestItem> & { sellerOwnerId: string }): string {
  const id = randomUUID();
  testItems.set(id, { title: "Test course", pricePaise: 100000n, sellerOwnerType: "USER", purchasable: true, ...item });
  return id;
}

@Injectable()
export class TestItemProvider implements SellableProvider, OnModuleInit {
  readonly type = "TEST_ITEM";

  constructor(private readonly moduleRef: ModuleRef) {}

  onModuleInit() {
    // strict:false -> the registry lives in BillingModule, not in this (root) test module.
    this.moduleRef.get(SellableRegistry, { strict: false }).register(this);
  }

  async describe(itemId: string, ctx: { buyerId: string }): Promise<SellableDescription> {
    const item = testItems.get(itemId);
    if (!item) throw new AppError("ITEM_NOT_FOUND", 404, "Item not found");
    if (testState.owned.has(`${ctx.buyerId}:${itemId}`)) return { ...item, purchasable: false, reason: "You already own this item" };
    return item;
  }

  async onPaid(tx: Prisma.TransactionClient, order: PaidOrder): Promise<void> {
    if (testState.failOnPaid) {
      // A half-done grant: it must vanish with the failure (savepoint rollback), never stay behind.
      if (testState.writeMarkerBeforeFail) await tx.notification.create({ data: { userId: order.buyerId, type: "test.marker", title: "marker", body: order.id } });
      throw testState.failOnPaid;
    }
    testState.owned.add(`${order.buyerId}:${order.items[0].itemId}`);
    testState.paid.push(order.id);
  }

  async onRefunded(_tx: Prisma.TransactionClient, order: PaidOrder): Promise<void> {
    testState.owned.delete(`${order.buyerId}:${order.items[0].itemId}`);
    testState.refunded.push(order.id);
  }
}
