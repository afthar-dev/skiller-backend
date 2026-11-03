// Public surface of the billing module. Other modules import only from here.
// Entitlements first: media and organizations (which billing's module graph reaches through users) import them from this index
// while it is still loading, so they must already be exported before the module lines at the bottom run.
export { EntitlementsService } from "./entitlements.service";
export type { Owner, OwnerType, PlanSnapshot } from "./entitlements.service";
export { UsageRegistry } from "./usage.registry";
export { EntitlementsModule } from "./entitlements.module";
export { LIMIT_KEYS } from "./plan-catalog";
export type { LimitKey, PlanLimits } from "./plan-catalog";
export { seedPlans } from "./plans-seed";
export { commissionSplit, fromApi, fromGatewayAmount, gstSplit, splitBps, toApi } from "./money";
export type { Paise } from "./money";
export { RAZORPAY_CLIENT, RazorpayApiError } from "./razorpay.client";
export type {
  CreatePlanInput,
  CreateSubscriptionInput,
  RazorpayClient,
  RazorpayNotes,
  RazorpayOrder,
  RazorpayPayment,
  RazorpayPlan,
  RazorpayRefund,
  RazorpaySubscription,
} from "./razorpay.client";
export { FakeRazorpayClient } from "./razorpay.fake";
export type { FakeWebhook } from "./razorpay.fake";
export { WebhookDispatcher } from "./webhook.dispatcher";
export type { WebhookEventContext, WebhookHandler } from "./webhook.dispatcher";
export { SubscriptionsService } from "./subscriptions.service";
export { BillingModule } from "./billing.module";
