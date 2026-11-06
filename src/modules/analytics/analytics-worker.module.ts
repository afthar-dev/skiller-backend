import { Module } from "@nestjs/common";
import { ActivityTracker } from "../../common/activity/activity-tracker";
import { ClockModule } from "../../common/clock/clock";
import { ANALYTICS_CORE_PROVIDERS } from "./analytics-core";
import { RollupProcessor } from "./rollup.processor";

/** Worker process: the 03:00 IST rollup job and the on-demand rebuild. */
@Module({
  imports: [ClockModule],
  providers: [...ANALYTICS_CORE_PROVIDERS, ActivityTracker],
  exports: [RollupProcessor],
})
export class AnalyticsWorkerModule {}
