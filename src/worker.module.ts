import { Module, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigModule } from "./common/config/config.module";
import { OutboxModule } from "./common/outbox/outbox.module";
import { OutboxRelay } from "./common/outbox/outbox.relay";
import { PrismaModule } from "./common/prisma/prisma.module";
import { QueueModule } from "./common/queue/queue.module";
import { QueueWorkerRunner } from "./common/queue/queue-worker.runner";
import { RedisModule } from "./common/redis/redis.module";

// Feature modules that own queue processors / relays are added to `imports` as they land.
@Module({
  imports: [ConfigModule, PrismaModule, RedisModule, QueueModule.register(), OutboxModule],
})
export class WorkerModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly runner: QueueWorkerRunner,
    private readonly outboxRelay: OutboxRelay,
  ) {}

  async onApplicationBootstrap() {
    await this.runner.start();
    await this.outboxRelay.schedule();
  }

  async onApplicationShutdown() {
    await this.runner.stop();
  }
}
