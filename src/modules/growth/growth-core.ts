import type { Provider } from "@nestjs/common";
import { ActivitySegmentProvider, AccountService } from "../identity";
import { PlanSegmentProvider, PurchaseSegmentProvider } from "../billing";
import { InterestSegmentProvider } from "../reels";
import { PlatformRoleDirectory, RoleSegmentProvider } from "../rbac";
import { CampaignAlerts } from "./campaign-alerts";
import { CampaignMailHooks } from "./campaign-hooks";
import { CampaignProcessor } from "./campaign.processor";
import { CampaignSender } from "./campaign-sender";
import { PromoMailProcessor } from "./promo-mail.processor";
import { SEGMENT_PROVIDERS, SegmentEvaluator } from "./segment";
import { UnsubscribeTokens } from "./unsubscribe-token";

const PROVIDER_CLASSES = [RoleSegmentProvider, PlanSegmentProvider, InterestSegmentProvider, ActivitySegmentProvider, PurchaseSegmentProvider];

/**
 * What both the API and the worker run for campaigns. The segment providers are small classes that need only the database (and the clock), exported by the
 * modules that own the data; they are built here so the worker does not need those modules' whole graphs.
 */
export const GROWTH_CORE_PROVIDERS: Provider[] = [
  ...PROVIDER_CLASSES,
  { provide: SEGMENT_PROVIDERS, useFactory: (...providers: unknown[]) => providers, inject: PROVIDER_CLASSES },
  AccountService,
  PlatformRoleDirectory,
  SegmentEvaluator,
  UnsubscribeTokens,
  CampaignAlerts,
  CampaignSender,
  PromoMailProcessor,
  CampaignMailHooks,
  CampaignProcessor,
];
