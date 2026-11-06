import { Module } from "@nestjs/common";
import { ANALYTICS_CORE_PROVIDERS } from "./analytics-core";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";
import { RebuildService } from "./rebuild.service";
import "./permissions";

/**
 * Admin growth dashboards over the daily rollup. The API also holds the rollup service (a rebuild is queued from here and run by the worker's
 * RollupProcessor, which is only registered in the worker).
 */
@Module({
  controllers: [AnalyticsController],
  providers: [...ANALYTICS_CORE_PROVIDERS, AnalyticsService, RebuildService],
})
export class AnalyticsModule {}
