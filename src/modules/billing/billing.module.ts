import { Module, type Provider } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { HttpRazorpayClient, RAZORPAY_CLIENT } from "./razorpay.client";
import { WebhookDispatcher } from "./webhook.dispatcher";
import { WebhookProcessor } from "./webhook.processor";
import { WebhooksController } from "./webhooks.controller";

/** Shared by the API and worker modules so both build the same client / dispatcher / processor. */
export const BILLING_CORE_PROVIDERS: Provider[] = [
  {
    provide: RAZORPAY_CLIENT,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) => new HttpRazorpayClient(config.razorpay.keyId, config.razorpay.keySecret),
  },
  WebhookDispatcher,
  WebhookProcessor,
];

export const BILLING_CORE_EXPORTS = [RAZORPAY_CLIENT, WebhookDispatcher];

@Module({
  imports: [ClockModule],
  controllers: [WebhooksController],
  providers: BILLING_CORE_PROVIDERS,
  exports: BILLING_CORE_EXPORTS,
})
export class BillingModule {}
