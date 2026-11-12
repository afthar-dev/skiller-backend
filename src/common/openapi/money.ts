import { applyDecorators } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";

/**
 * Money on the wire is integer paise as a decimal string (never a JSON number): `Money`. Response shapes that carry money are declared
 * here so the contract shows it; `buildOpenApiDocument` merges `moneyComponents` into `components.schemas`.
 */
export const MONEY_PATTERN = "^-?[0-9]+$";
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const money = ref("Money");
const str = { type: "string" } as const;
const nullableStr = { type: "string", nullable: true } as const;
const int = { type: "integer" } as const;
const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: "object", required, properties });

const planLimits = { type: "object", additionalProperties: true, description: "max_published_courses, storage_gb, reels_per_day, analytics_level, creator_coupons, org_seats, max_active_gigs (null = unlimited; max_active_gigs may be left out on write: the plan key's default applies)." };

export const moneyComponents: Record<string, unknown> = {
  Money: { type: "string", pattern: MONEY_PATTERN, example: "123400", description: "Integer paise (1/100 rupee) as a decimal string. Never a JSON number: amounts can exceed 2^53." },
  CheckoutStarted: obj({ orderId: str, razorpayOrderId: str, amountPaise: money, currency: { type: "string", example: "INR" }, keyId: str }),
  OrderItem: obj({ itemType: str, itemId: str, title: str, unitPricePaise: money }),
  Order: obj({
    id: str,
    status: { type: "string", enum: ["CREATED", "PAID", "FAILED", "EXPIRED", "REFUNDED", "PARTIALLY_REFUNDED"] },
    currency: str,
    listPricePaise: money,
    discountPaise: money,
    totalPaise: money,
    couponCode: nullableStr,
    razorpayOrderId: nullableStr,
    items: { type: "array", items: ref("OrderItem") },
    createdAt: { type: "string", format: "date-time" },
    paidAt: { type: "string", format: "date-time", nullable: true },
    invoiceId: nullableStr,
    creditNoteId: nullableStr,
    refund: {
      type: "object",
      nullable: true,
      description: "The order's live refund; null when none was asked for or it was rejected or failed.",
      required: ["id", "status", "requestedAt"],
      properties: { id: str, status: { type: "string", enum: ["REQUESTED", "APPROVED", "PROCESSING", "PROCESSED"] }, requestedAt: { type: "string", format: "date-time" } },
    },
  }),
  AdminOrder: {
    allOf: [ref("Order"), obj({ buyerId: str, sellerOwnerType: { type: "string", enum: ["USER", "ORG"] }, sellerOwnerId: str, commissionBps: int, razorpayPaymentId: nullableStr, fulfilmentFailedAt: { type: "string", format: "date-time", nullable: true } })],
  },
  Wallet: obj({
    currency: str,
    balances: obj({ available: money, pending: money, payoutLocked: money }),
    lifetimeEarnedPaise: money,
    lifetimeWithdrawnPaise: money,
    minPayoutPaise: money,
    tdsBps: int,
  }),
  LedgerLine: obj({ id: str, kind: { type: "string", enum: ["AVAILABLE", "PENDING", "PAYOUT_LOCKED"] }, amountPaise: money, refType: str, refId: str, description: str, createdAt: { type: "string", format: "date-time" } }),
  Payout: obj({
    id: str,
    ownerType: { type: "string", enum: ["USER", "ORG"] },
    ownerId: str,
    status: { type: "string", enum: ["REQUESTED", "APPROVED", "PROCESSING", "PAID", "REJECTED", "REVERSED", "FAILED", "MANUAL_REVIEW"] },
    mode: { type: "string", enum: ["IMPS", "UPI", "NEFT"] },
    amountPaise: money,
    tdsPaise: money,
    tdsBps: int,
    netPaise: money,
    currency: str,
    utr: nullableStr,
    failureReason: nullableStr,
    requestedBy: str,
    approvedBy: nullableStr,
    createdAt: { type: "string", format: "date-time" },
    approvedAt: { type: "string", format: "date-time", nullable: true },
    paidAt: { type: "string", format: "date-time", nullable: true },
    destination: { type: "object", nullable: true, additionalProperties: true },
  }),
  Refund: obj({
    id: str,
    orderId: str,
    status: { type: "string", enum: ["REQUESTED", "APPROVED", "PROCESSING", "PROCESSED", "REJECTED", "FAILED"] },
    amountPaise: money,
    currency: str,
    reason: str,
    requestedBy: str,
    decidedBy: nullableStr,
    failureReason: nullableStr,
    createdAt: { type: "string", format: "date-time" },
  }),
  PlanVersion: obj({ id: str, planId: str, pricePaise: money, currency: str, interval: { type: "string", enum: ["MONTH", "YEAR"] }, commissionBps: int, limits: planLimits, createdAt: { type: "string", format: "date-time" } }),
  Plan: obj({ id: str, key: str, name: str, audience: { type: "string", enum: ["CREATOR", "ORG"] }, isActive: { type: "boolean" }, versions: { type: "array", items: ref("PlanVersion") } }),
  PlanList: obj({ items: { type: "array", items: ref("Plan") } }),
  Coupon: obj({
    id: str,
    code: str,
    kind: { type: "string", enum: ["PERCENT", "FLAT"] },
    value: { ...money, description: "PERCENT: basis points (2000 = 20%). FLAT: paise." },
    fundedBy: { type: "string", enum: ["PLATFORM", "CREATOR"] },
    scope: { type: "string", enum: ["ALL", "SELLER", "ITEM"] },
    ownerType: { type: "string", nullable: true, enum: ["USER", "ORG", null] },
    ownerId: nullableStr,
    itemType: nullableStr,
    itemId: nullableStr,
    maxUses: { type: "integer", nullable: true },
    expiresAt: { type: "string", format: "date-time", nullable: true },
    isActive: { type: "boolean" },
    usedCount: int,
    createdAt: { type: "string", format: "date-time" },
  }),
  FinanceSummary: obj({
    from: str,
    to: str,
    currency: str,
    gmvPaise: money,
    orderCount: int,
    platformRevenuePaise: money,
    taxPayablePaise: money,
    refundsProcessedPaise: money,
    refundCount: int,
    payoutsPaidPaise: money,
    payoutsPaidCount: int,
    payoutsPendingPaise: money,
    payoutsPendingCount: int,
    activePaidSubscribers: int,
  }),
  ReconciliationRun: obj({
    id: str,
    date: { type: "string", example: "2026-11-03", description: "IST calendar day." },
    status: { type: "string", enum: ["OK", "MISMATCH", "ERROR"] },
    details: { type: "object", additionalProperties: true, description: "Per check: counts and the mismatching items (amounts are Money strings)." },
    startedAt: { type: "string", format: "date-time" },
    finishedAt: { type: "string", format: "date-time", nullable: true },
  }),
  SubscriptionUsage: obj({ used: { type: "integer", nullable: true }, limit: { type: "integer", nullable: true, description: "Bytes for storage_gb, a count otherwise; null = unlimited." }, unit: { type: "string", enum: ["bytes", "count"] } }),
  MySubscription: obj({
    subscriptionId: nullableStr,
    plan: obj({ key: str, versionId: str, commissionBps: int }),
    status: { type: "string", enum: ["TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED", "EXPIRED"] },
    currentPeriodEnd: { type: "string", format: "date-time", nullable: true },
    cancelAtPeriodEnd: { type: "boolean" },
    graceEndsAt: { type: "string", format: "date-time", nullable: true },
    scheduledPlanVersionId: nullableStr,
    limits: planLimits,
    usage: { type: "object", additionalProperties: ref("SubscriptionUsage"), description: "Per limit key: storage_gb, max_published_courses, reels_per_day, org_seats, max_active_gigs." },
  }),
  SubscriptionCheckout: obj({ subscriptionId: str, razorpaySubscriptionId: str, keyId: str }),
  SubscriptionChange: {
    description: "ON_PAYMENT (upgrade): open Razorpay checkout with the returned ids. AT_PERIOD_END (downgrade): booked for the period end.",
    oneOf: [
      obj({ effective: { type: "string", enum: ["ON_PAYMENT"] }, subscriptionId: str, razorpaySubscriptionId: str, keyId: str }),
      obj({ effective: { type: "string", enum: ["AT_PERIOD_END"] }, subscriptionId: str, scheduledPlanVersionId: str, effectiveAt: { type: "string", format: "date-time", nullable: true } }),
    ],
  },
  PayoutAccount: obj({
    id: str,
    type: { type: "string", enum: ["BANK", "UPI"] },
    status: { type: "string", enum: ["PENDING", "VERIFIED", "FAILED", "INACTIVE"] },
    holderName: str,
    ifsc: nullableStr,
    accountLast4: nullableStr,
    vpaMasked: nullableStr,
    panLast4: str,
    panNameMatch: { type: "boolean", nullable: true },
    failureReason: nullableStr,
    verifiedAt: { type: "string", format: "date-time", nullable: true },
    cooldownEndsAt: { type: "string", format: "date-time", description: "Payouts are blocked until this moment." },
    createdAt: { type: "string", format: "date-time" },
  }),
  CurrentPayoutAccount: obj({ account: { allOf: [ref("PayoutAccount")], nullable: true } }),
};

const page = (name: string) => ({ type: "object", required: ["items", "nextCursor"], properties: { items: { type: "array", items: ref(name) }, nextCursor: { type: "string", nullable: true } } });

/** Documents the success body of a route as a component from `moneyComponents`. */
export const ApiResult = (status: number, name: string, description = "Success") => applyDecorators(ApiResponse({ status, description, schema: ref(name) as never }));
/** Documents the success body of a list route: `{ items: Name[], nextCursor }`. */
export const ApiPageResult = (name: string, description = "A page of results") => applyDecorators(ApiResponse({ status: 200, description, schema: page(name) as never }));
/** Documents a list route that returns a bare array. */
export const ApiListResult = (name: string, description = "Success") => applyDecorators(ApiResponse({ status: 200, description, schema: { type: "array", items: ref(name) } as never }));
