import { Module } from "@nestjs/common";
import { CampaignsController } from "./campaigns.controller";
import { CampaignsService } from "./campaigns.service";
import { GROWTH_CORE_PROVIDERS } from "./growth-core";
import { UnsubscribeController } from "./unsubscribe.controller";
import { UnsubscribeService } from "./unsubscribe.service";

/**
 * Promotional email campaigns and the unsubscribe link. Segments are answered by exported providers of the modules that own the data; recipients,
 * suppressions and preferences are read through those modules' exports. Sending runs in the worker (GrowthWorkerModule) from the same core providers.
 */
@Module({
  controllers: [CampaignsController, UnsubscribeController],
  providers: [...GROWTH_CORE_PROVIDERS, CampaignsService, UnsubscribeService],
})
export class GrowthModule {}
