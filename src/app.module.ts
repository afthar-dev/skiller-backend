import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ConfigModule, APP_CONFIG } from "./common/config/config.module";
import type { AppConfig } from "./common/config/config.schema";
import { ErrorFilter } from "./common/errors/error.filter";
import { RequestIdMiddleware } from "./common/http/request-id.middleware";
import { PrismaModule } from "./common/prisma/prisma.module";
import { QueueModule } from "./common/queue/queue.module";
import { RedisModule } from "./common/redis/redis.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [ConfigModule, PrismaModule, RedisModule, QueueModule.register()],
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
