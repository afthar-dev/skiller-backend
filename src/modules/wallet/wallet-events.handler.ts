import { Injectable, OnModuleInit } from "@nestjs/common";
import { EventBus } from "../../common/outbox/event-bus";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AccountsService } from "./accounts.service";

/** Creates the seller ledger accounts when a user becomes a creator or an organization is created. Idempotent (the outbox is at-least-once). */
@Injectable()
export class WalletEventHandlers implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
  ) {}

  onModuleInit() {
    this.bus.on("user.became_creator", async (e) => {
      await this.prisma.$transaction((tx) => this.accounts.ensureSellerAccounts(tx, "USER", e.userId));
    });
    this.bus.on("org.created", async (e) => {
      await this.prisma.$transaction((tx) => this.accounts.ensureSellerAccounts(tx, "ORG", e.orgId));
    });
  }
}
