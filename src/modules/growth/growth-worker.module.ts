import { Module } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { PromoPreferences } from "../notifications";
import { CampaignProcessor } from "./campaign.processor";
import { GROWTH_CORE_PROVIDERS } from "./growth-core";

/** Worker process: the campaign tick (starts due campaigns, sends the next batches) and the hooks that file Resend ids and delivery events. */
@Module({
  imports: [ClockModule],
  providers: [...GROWTH_CORE_PROVIDERS, PromoPreferences],
  exports: [CampaignProcessor],
})
export class GrowthWorkerModule {}
