import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ClockModule } from "./common/clock/clock";
import { ConfigModule, APP_CONFIG } from "./common/config/config.module";
import type { AppConfig } from "./common/config/config.schema";
import { ErrorFilter } from "./common/errors/error.filter";
import { RequestIdMiddleware } from "./common/http/request-id.middleware";
import { OutboxModule } from "./common/outbox/outbox.module";
import { PrismaModule } from "./common/prisma/prisma.module";
import { QueueModule } from "./common/queue/queue.module";
import { RedisModule } from "./common/redis/redis.module";
import { AuditModule } from "./modules/audit/audit.module";
import { IdentityModule } from "./modules/identity/identity.module";
import { RbacModule } from "./modules/rbac/rbac.module";
import { UsersModule } from "./modules/users/users.module";
import { MailModule } from "./modules/mail/mail.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [ConfigModule, ClockModule, PrismaModule, RedisModule, QueueModule.register(), OutboxModule, MailModule, IdentityModule, AuditModule, RbacModule, UsersModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, inject: [APP_CONFIG], useFactory: (config: AppConfig) => new ErrorFilter(config.nodeEnv === "production") },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}
