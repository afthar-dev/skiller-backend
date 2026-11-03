import { Module, forwardRef, type Provider } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { OrganizationsModule } from "../organizations";
import { UsersModule } from "../users";
import { WalletModule } from "../wallet";
import { AdminBillingController } from "./admin-billing.controller";
import { OrgSubscriptionsController, PlansController, SubscriptionsController } from "./billing.controller";
import { EntitlementsModule } from "./entitlements.module";
import { PlansService } from "./plans.service";
import { HttpRazorpayClient, RAZORPAY_CLIENT } from "./razorpay.client";
import { SubscriptionHandlers } from "./subscription-handlers";
import { SubscriptionMaintenanceProcessor } from "./subscription-maintenance.processor";
import { SubscriptionsService } from "./subscriptions.service";
import { WebhookDispatcher } from "./webhook.dispatcher";
import { WebhookProcessor } from "./webhook.processor";
import { WebhooksController } from "./webhooks.controller";

/** Shared by the API and worker modules so both build the same client / dispatcher / processors / subscription handlers. */
export const BILLING_CORE_PROVIDERS: Provider[] = [
  {
    provide: RAZORPAY_CLIENT,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) => new HttpRazorpayClient(config.razorpay.keyId, config.razorpay.keySecret),
  },
  WebhookDispatcher,
  WebhookProcessor,
  SubscriptionsService,
  SubscriptionHandlers,
  SubscriptionMaintenanceProcessor,
];

export const BILLING_CORE_EXPORTS = [RAZORPAY_CLIENT, WebhookDispatcher, SubscriptionsService, SubscriptionMaintenanceProcessor];

@Module({
  // forwardRef: module classes arrive through other modules' index files, which may still be loading when this file is evaluated.
  imports: [ClockModule, EntitlementsModule, WalletModule, forwardRef(() => UsersModule), forwardRef(() => OrganizationsModule)],
  controllers: [WebhooksController, PlansController, SubscriptionsController, OrgSubscriptionsController, AdminBillingController],
  providers: [...BILLING_CORE_PROVIDERS, PlansService],
  exports: [...BILLING_CORE_EXPORTS, EntitlementsModule],
})
export class BillingModule {}
