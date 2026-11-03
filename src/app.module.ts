import { Module } from "@nestjs/common";
import { ConfigModule } from "./common/config/config.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [ConfigModule],
  controllers: [HealthController],
})
export class AppModule {}
