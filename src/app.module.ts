import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { APP_FILTER } from "@nestjs/core";
import { ClockModule } from "./common/clock/clock";
import { ConfigModule, APP_CONFIG } from "./common/config/config.module";
import type { AppConfig } from "./common/config/config.schema";
import { ErrorFilter } from "./common/errors/error.filter";
import { RequestIdMiddleware } from "./common/http/request-id.middleware";
import { buildLoggerParams } from "./common/observability/logger";
import { OutboxModule } from "./common/outbox/outbox.module";
import { PrismaModule } from "./common/prisma/prisma.module";
import { QueueModule } from "./common/queue/queue.module";
import { RedisModule } from "./common/redis/redis.module";
import { AuditModule } from "./modules/audit/audit.module";
import { IdentityModule } from "./modules/identity/identity.module";
import { RbacModule } from "./modules/rbac/rbac.module";
import { OrganizationsModule } from "./modules/organizations/organizations.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { AdminModule } from "./modules/admin/admin.module";
import { UsersModule } from "./modules/users/users.module";
import { MailModule } from "./modules/mail/mail.module";
import { MediaModule } from "./modules/media/media.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({ inject: [APP_CONFIG], useFactory: (config: AppConfig) => buildLoggerParams(config) }),
    ClockModule, PrismaModule, RedisModule, QueueModule.register(), OutboxModule, MailModule, IdentityModule, AuditModule, RbacModule, UsersModule, MediaModule, OrganizationsModule, NotificationsModule, AdminModule],
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
