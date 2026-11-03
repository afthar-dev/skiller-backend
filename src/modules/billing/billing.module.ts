import { Module, forwardRef, type Provider } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { IdempotencyCleanup } from "../../common/idempotency";
import { OrganizationsModule } from "../organizations";
import { ObjectStorageModule } from "../media";
import { UsersModule } from "../users";
import { WalletModule } from "../wallet";
import { AdminBillingController } from "./admin-billing.controller";
import { CheckoutController, InvoicesController, OrdersController, OrgSubscriptionsController, PlansController, SubscriptionsController } from "./billing.controller";
import { CheckoutService } from "./checkout.service";
import { CouponsService } from "./coupons.service";
import { EntitlementsModule } from "./entitlements.module";
import { FinanceAlerts } from "./finance-alerts.service";
import { FulfilmentService } from "./fulfilment.service";
import { HoldReleaseProcessor } from "./hold-release.processor";
import { InvoiceHandlers } from "./invoice-handlers";
import { InvoiceIssuer } from "./invoice-issuer";
import { InvoicesProcessor } from "./invoices.processor";
import { InvoicesService } from "./invoices.service";
import { OrderHandlers } from "./order-handlers";
import { OrderMaintenanceProcessor } from "./order-maintenance.processor";
import { OrdersService } from "./orders.service";
import { PlansService } from "./plans.service";
import { HttpRazorpayClient, RAZORPAY_CLIENT } from "./razorpay.client";
import { SellableRegistry } from "./sellable.registry";
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
  SellableRegistry,
  CouponsService,
  IdempotencyCleanup,
  OrdersService,
  FinanceAlerts,
  FulfilmentService,
  OrderHandlers,
  OrderMaintenanceProcessor,
  HoldReleaseProcessor,
  InvoiceIssuer,
  InvoiceHandlers,
  InvoicesProcessor,
];

export const BILLING_CORE_EXPORTS = [RAZORPAY_CLIENT, WebhookDispatcher, SubscriptionsService, SubscriptionMaintenanceProcessor, SellableRegistry, FulfilmentService, OrdersService, OrderMaintenanceProcessor, HoldReleaseProcessor, InvoicesProcessor];

@Module({
  // forwardRef: module classes arrive through other modules' index files, which may still be loading when this file is evaluated.
  imports: [ClockModule, EntitlementsModule, WalletModule, ObjectStorageModule, forwardRef(() => UsersModule), forwardRef(() => OrganizationsModule)],
  controllers: [WebhooksController, PlansController, SubscriptionsController, OrgSubscriptionsController, CheckoutController, OrdersController, InvoicesController, AdminBillingController],
  providers: [...BILLING_CORE_PROVIDERS, PlansService, CheckoutService, InvoicesService],
  exports: [...BILLING_CORE_EXPORTS, CouponsService, EntitlementsModule],
})
export class BillingModule {}
