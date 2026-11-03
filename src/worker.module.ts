import { Module, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { APP_CONFIG, ConfigModule } from "./common/config/config.module";
import type { AppConfig } from "./common/config/config.schema";
import { buildLoggerParams } from "./common/observability/logger";
import { OutboxModule } from "./common/outbox/outbox.module";
import { OutboxRelay } from "./common/outbox/outbox.relay";
import { BillingWorkerModule } from "./modules/billing/billing-worker.module";
import { HoldReleaseProcessor } from "./modules/billing/hold-release.processor";
import { InvoicesProcessor } from "./modules/billing/invoices.processor";
import { OrderMaintenanceProcessor } from "./modules/billing/order-maintenance.processor";
import { SubscriptionMaintenanceProcessor } from "./modules/billing/subscription-maintenance.processor";
import { WalletWorkerModule } from "./modules/wallet/wallet-worker.module";
import { RbacWorkerModule } from "./modules/rbac/rbac-worker.module";
import { UsersWorkerModule } from "./modules/users/users-worker.module";
import { SettingsModule } from "./modules/admin/settings.module";
import { MailModule } from "./modules/mail/mail.module";
import { NotificationsWorkerModule } from "./modules/notifications/notifications-worker.module";
import { MediaCleanupProcessor } from "./modules/media/media-cleanup.processor";
import { MediaWorkerModule } from "./modules/media/media-worker.module";
import { PrismaModule } from "./common/prisma/prisma.module";
import { QueueModule } from "./common/queue/queue.module";
import { QueueWorkerRunner } from "./common/queue/queue-worker.runner";
import { RedisModule } from "./common/redis/redis.module";

// Feature modules that own queue processors / relays are added to `imports` as they land.
@Module({
  imports: [ConfigModule, LoggerModule.forRootAsync({ inject: [APP_CONFIG], useFactory: (config: AppConfig) => buildLoggerParams(config) }), PrismaModule, RedisModule, QueueModule.register(), OutboxModule, MailModule, SettingsModule, RbacWorkerModule, UsersWorkerModule, MediaWorkerModule, NotificationsWorkerModule, WalletWorkerModule, BillingWorkerModule],
})
export class WorkerModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly runner: QueueWorkerRunner,
    private readonly outboxRelay: OutboxRelay,
    private readonly mediaCleanup: MediaCleanupProcessor,
    private readonly subscriptionMaintenance: SubscriptionMaintenanceProcessor,
    private readonly orderMaintenance: OrderMaintenanceProcessor,
    private readonly holdRelease: HoldReleaseProcessor,
    private readonly invoices: InvoicesProcessor,
  ) {}

  async onApplicationBootstrap() {
    await this.runner.start();
    await this.outboxRelay.schedule();
    await this.mediaCleanup.schedule();
    await this.subscriptionMaintenance.schedule();
    await this.orderMaintenance.schedule();
    await this.holdRelease.schedule();
    await this.invoices.schedule();
  }

  async onApplicationShutdown() {
    await this.runner.stop();
  }
}
