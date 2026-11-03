import { Module, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigModule } from "./common/config/config.module";
import { OutboxModule } from "./common/outbox/outbox.module";
import { OutboxRelay } from "./common/outbox/outbox.relay";
import { RbacWorkerModule } from "./modules/rbac/rbac-worker.module";
import { UsersWorkerModule } from "./modules/users/users-worker.module";
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
  imports: [ConfigModule, PrismaModule, RedisModule, QueueModule.register(), OutboxModule, MailModule, RbacWorkerModule, UsersWorkerModule, MediaWorkerModule, NotificationsWorkerModule],
})
export class WorkerModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly runner: QueueWorkerRunner,
    private readonly outboxRelay: OutboxRelay,
    private readonly mediaCleanup: MediaCleanupProcessor,
  ) {}

  async onApplicationBootstrap() {
    await this.runner.start();
    await this.outboxRelay.schedule();
    await this.mediaCleanup.schedule();
  }

  async onApplicationShutdown() {
    await this.runner.stop();
  }
}
