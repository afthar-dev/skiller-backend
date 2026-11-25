import { Logger, Module, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
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
import { PayoutMaintenanceProcessor } from "./modules/billing/payout.processor";
import { ReconciliationProcessor } from "./modules/billing/reconciliation.processor";
import { RefundsProcessor } from "./modules/billing/refunds.processor";
import { SubscriptionMaintenanceProcessor } from "./modules/billing/subscription-maintenance.processor";
import { CoursesWorkerModule } from "./modules/courses/courses-worker.module";
import { CourseMaintenanceProcessor } from "./modules/courses/course-maintenance.processor";
import { ReelsWorkerModule } from "./modules/reels/reels-worker.module";
import { HashtagTrendingProcessor } from "./modules/reels/hashtag-trending.processor";
import { ReelViewsFlushProcessor } from "./modules/reels/reel-views-flush.processor";
import { GrowthWorkerModule } from "./modules/growth/growth-worker.module";
import { CampaignProcessor } from "./modules/growth/campaign.processor";
import { AnalyticsWorkerModule } from "./modules/analytics/analytics-worker.module";
import { RollupProcessor } from "./modules/analytics/rollup.processor";
import { WalletWorkerModule } from "./modules/wallet/wallet-worker.module";
import { RbacWorkerModule } from "./modules/rbac/rbac-worker.module";
import { UsersWorkerModule } from "./modules/users/users-worker.module";
import { SettingsModule } from "./modules/admin/settings.module";
import { MailModule } from "./modules/mail/mail.module";
import { NotificationsWorkerModule } from "./modules/notifications/notifications-worker.module";
import { MediaCleanupProcessor } from "./modules/media/media-cleanup.processor";
import { MediaStuckSweeper } from "./modules/media/media-stuck.sweeper";
import { MediaWorkerModule } from "./modules/media/media-worker.module";
import { waitForMigrations } from "./common/prisma/migration-gate";
import { PrismaModule } from "./common/prisma/prisma.module";
import { PrismaService } from "./common/prisma/prisma.service";
import { QueueModule } from "./common/queue/queue.module";
import { QueueWorkerRunner } from "./common/queue/queue-worker.runner";
import { RedisModule } from "./common/redis/redis.module";

// Feature modules that own queue processors / relays are added to `imports` as they land.
@Module({
  imports: [ConfigModule, LoggerModule.forRootAsync({ inject: [APP_CONFIG], useFactory: (config: AppConfig) => buildLoggerParams(config) }), PrismaModule, RedisModule, QueueModule.register(), OutboxModule, MailModule, SettingsModule, RbacWorkerModule, UsersWorkerModule, MediaWorkerModule, NotificationsWorkerModule, WalletWorkerModule, BillingWorkerModule, CoursesWorkerModule, ReelsWorkerModule, GrowthWorkerModule, AnalyticsWorkerModule],
})
export class WorkerModule implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    private readonly runner: QueueWorkerRunner,
    private readonly prisma: PrismaService,
    private readonly outboxRelay: OutboxRelay,
    private readonly mediaCleanup: MediaCleanupProcessor,
    private readonly mediaStuck: MediaStuckSweeper,
    private readonly subscriptionMaintenance: SubscriptionMaintenanceProcessor,
    private readonly orderMaintenance: OrderMaintenanceProcessor,
    private readonly holdRelease: HoldReleaseProcessor,
    private readonly invoices: InvoicesProcessor,
    private readonly refunds: RefundsProcessor,
    private readonly payouts: PayoutMaintenanceProcessor,
    private readonly reconciliation: ReconciliationProcessor,
    private readonly courseMaintenance: CourseMaintenanceProcessor,
    private readonly reelViewsFlush: ReelViewsFlushProcessor,
    private readonly hashtagTrending: HashtagTrendingProcessor,
    private readonly campaigns: CampaignProcessor,
    private readonly analyticsRollup: RollupProcessor,
  ) {}

  async onApplicationBootstrap() {
    // Never run this build's jobs against a schema the API has not migrated yet.
    await waitForMigrations(this.prisma, { log: (m) => Logger.warn(m, "WorkerModule") });
    await this.runner.start();
    await this.outboxRelay.schedule();
    await this.mediaCleanup.schedule();
    await this.mediaStuck.schedule();
    await this.subscriptionMaintenance.schedule();
    await this.orderMaintenance.schedule();
    await this.holdRelease.schedule();
    await this.invoices.schedule();
    await this.refunds.schedule();
    await this.payouts.schedule();
    await this.reconciliation.schedule();
    await this.courseMaintenance.schedule();
    await this.reelViewsFlush.schedule();
    await this.hashtagTrending.schedule();
    await this.campaigns.schedule();
    await this.analyticsRollup.schedule();
  }

  /**
   * Nest runs every onModuleDestroy before any onApplicationShutdown, and the root module's hooks run before the feature modules'. Stopping the workers here
   * (close() waits for running jobs) means PrismaService, which disconnects in its own onModuleDestroy, is still connected while jobs finish.
   */
  async onModuleDestroy() {
    await this.runner.stop();
  }
}
