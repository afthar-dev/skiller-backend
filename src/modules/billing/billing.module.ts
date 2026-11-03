import { Module, forwardRef, type Provider } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { IdempotencyCleanup } from "../../common/idempotency";
import { OrganizationsModule } from "../organizations";
import { ObjectStorageModule } from "../media";
import { UsersModule } from "../users";
import { WalletModule } from "../wallet";
import { AdminBillingController, AdminRefundsController } from "./admin-billing.controller";
import { AdminWalletController } from "./admin-wallet.controller";
import { CheckoutController, CreditNotesController, InvoicesController, OrderRefundsController, OrdersController, OrgSubscriptionsController, PlansController, SubscriptionsController } from "./billing.controller";
import { CheckoutService } from "./checkout.service";
import { CouponsService } from "./coupons.service";
import { EntitlementsModule } from "./entitlements.module";
import { FinanceAlerts } from "./finance-alerts.service";
import { FulfilmentService } from "./fulfilment.service";
import { HoldReleaseProcessor } from "./hold-release.processor";
import { CreditNoteIssuer } from "./credit-note-issuer";
import { InvoiceHandlers } from "./invoice-handlers";
import { InvoiceIssuer } from "./invoice-issuer";
import { InvoicesProcessor } from "./invoices.processor";
import { InvoicesService } from "./invoices.service";
import { OrderHandlers } from "./order-handlers";
import { OrderMaintenanceProcessor } from "./order-maintenance.processor";
import { OrdersService } from "./orders.service";
import { PayoutAccountHandlers } from "./payout-account-handlers";
import { PayoutAccountsService } from "./payout-accounts.service";
import { PlansService } from "./plans.service";
import { DefaultRefundEligibility, RefundEligibilityRegistry } from "./refund-eligibility";
import { RefundHandlers } from "./refund-handlers";
import { RefundRequestsService } from "./refund-requests.service";
import { RefundsProcessor } from "./refunds.processor";
import { RefundsService } from "./refunds.service";
import { HttpRazorpayClient, RAZORPAY_CLIENT } from "./razorpay.client";
import { HttpRazorpayXClient, RAZORPAYX_CLIENT } from "./razorpayx.client";
import { SellableRegistry } from "./sellable.registry";
import { SubscriptionHandlers } from "./subscription-handlers";
import { SubscriptionMaintenanceProcessor } from "./subscription-maintenance.processor";
import { SubscriptionsService } from "./subscriptions.service";
import { WebhookDispatcher } from "./webhook.dispatcher";
import { WebhookProcessor } from "./webhook.processor";
import { WalletController, OrgWalletController } from "./wallet.controller";
import { WebhooksController } from "./webhooks.controller";

/** Shared by the API and worker modules so both build the same client / dispatcher / processors / subscription handlers. */
export const BILLING_CORE_PROVIDERS: Provider[] = [
  {
    provide: RAZORPAY_CLIENT,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) => new HttpRazorpayClient(config.razorpay.keyId, config.razorpay.keySecret),
  },
  {
    provide: RAZORPAYX_CLIENT,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) => new HttpRazorpayXClient(config.razorpay.keyId, config.razorpay.keySecret, config.razorpayx.accountNumber),
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
  CreditNoteIssuer,
  InvoiceHandlers,
  InvoicesProcessor,
  DefaultRefundEligibility,
  RefundEligibilityRegistry,
  RefundsService,
  RefundHandlers,
  RefundsProcessor,
  PayoutAccountsService,
  PayoutAccountHandlers,
];

export const BILLING_CORE_EXPORTS = [RAZORPAY_CLIENT, RAZORPAYX_CLIENT, WebhookDispatcher, SubscriptionsService, SubscriptionMaintenanceProcessor, SellableRegistry, FulfilmentService, OrdersService, OrderMaintenanceProcessor, HoldReleaseProcessor, InvoicesProcessor, RefundEligibilityRegistry, RefundsProcessor];

@Module({
  // forwardRef: module classes arrive through other modules' index files, which may still be loading when this file is evaluated.
  imports: [ClockModule, EntitlementsModule, WalletModule, ObjectStorageModule, forwardRef(() => UsersModule), forwardRef(() => OrganizationsModule)],
  controllers: [WebhooksController, PlansController, SubscriptionsController, OrgSubscriptionsController, CheckoutController, OrdersController, OrderRefundsController, InvoicesController, CreditNotesController, AdminBillingController, AdminRefundsController, WalletController, OrgWalletController, AdminWalletController],
  providers: [...BILLING_CORE_PROVIDERS, PlansService, CheckoutService, InvoicesService, RefundRequestsService],
  exports: [...BILLING_CORE_EXPORTS, CouponsService, EntitlementsModule],
})
export class BillingModule {}
