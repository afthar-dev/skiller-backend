import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { AppError } from "../../common/errors/app-error";
import { parsePage } from "../../common/http/pagination";
import { Idempotent } from "../../common/idempotency";
import { ApiErrorResponse } from "../../common/openapi/error-response";
import { ApiPageResult, ApiResult } from "../../common/openapi/money";
import { ApiJsonResponse, objectSchema, schemas } from "../../common/openapi/responses";
import { ApiPagination, ApiZodBody } from "../../common/openapi/zod-schema";
import { PrismaService } from "../../common/prisma/prisma.service";
import { OrganizationsService } from "../organizations";
import { RequirePermission } from "../rbac";
import { ProfilesService } from "../users";
import { CheckoutService } from "./checkout.service";
import { FulfilmentService } from "./fulfilment.service";
import { InvoicesService } from "./invoices.service";
import { OrdersService } from "./orders.service";
import { PlansService } from "./plans.service";
import { RefundRequestsService } from "./refund-requests.service";
import { RAZORPAY_CLIENT, type RazorpayClient } from "./razorpay.client";
import { SubscriptionsService } from "./subscriptions.service";
import type { Owner } from "./entitlements.service";

const planBody = z.object({ planVersionId: z.string().uuid() }).strict();

@ApiTags("Billing")
@Controller()
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Public()
  @Get("plans")
  @ApiResult(200, "PlanList")
  @ApiOperation({ summary: "Plans a customer can buy now (newest version per interval)" })
  list() {
    return this.plans.listPublic();
  }
}

/** Creator subscriptions. The signed-in user must be a creator (403 CREATOR_REQUIRED). */
@ApiTags("Billing")
@Controller("subscriptions")
export class SubscriptionsController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly profiles: ProfilesService,
  ) {}

  private async owner(user: AuthUser): Promise<Owner> {
    if (!(await this.profiles.isCreator(user.id))) throw new AppError("CREATOR_REQUIRED", 403, "Only creators can subscribe to a plan");
    return { ownerType: "USER", ownerId: user.id };
  }

  @AuthenticatedOnly()
  @Get("me")
  @ApiOperation({ summary: "My plan, status, period end, limits and usage" })
  @ApiResult(200, "MySubscription")
  async me(@CurrentUser() user: AuthUser) {
    return this.subscriptions.me(await this.owner(user));
  }

  @AuthenticatedOnly()
  @Post("checkout")
  @HttpCode(201)
  @ApiOperation({ summary: "Start paying for a plan: creates the Razorpay subscription" })
  @ApiResult(201, "SubscriptionCheckout")
  @ApiZodBody(planBody)
  async checkout(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.subscriptions.checkout(await this.owner(user), planBody.parse(body).planVersionId, user.id);
  }

  @AuthenticatedOnly()
  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel at the end of the paid period" })
  @ApiResult(200, "MySubscription")
  async cancel(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.subscriptions.cancel(await this.owner(user), id);
  }

  @AuthenticatedOnly()
  @Post(":id/change")
  @HttpCode(200)
  @ApiOperation({ summary: "Upgrade now (pay for the new plan) or schedule a downgrade for the period end" })
  @ApiResult(200, "SubscriptionChange")
  @ApiZodBody(planBody)
  async change(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.subscriptions.change(await this.owner(user), id, planBody.parse(body).planVersionId, user.id);
  }
}

/** The same operations for an organization, authorised by `org.manage` on that org. */
@ApiTags("Billing")
@Controller("orgs/:slug/subscription")
export class OrgSubscriptionsController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly orgs: OrganizationsService,
  ) {}

  private async owner(slug: string): Promise<Owner> {
    const orgId = await this.orgs.idForSlug(slug);
    if (!orgId) throw new AppError("ORG_NOT_FOUND", 404, "Organization not found");
    return { ownerType: "ORG", ownerId: orgId };
  }

  @Get()
  @RequirePermission("org.manage", { orgParam: "slug" })
  @ApiOperation({ summary: "The organization's plan, status, period end, limits and usage" })
  @ApiResult(200, "MySubscription")
  async me(@Param("slug") slug: string) {
    return this.subscriptions.me(await this.owner(slug));
  }

  @Post("checkout")
  @HttpCode(201)
  @RequirePermission("org.wallet.manage", { orgParam: "slug", orgScopedOnly: true })
  @ApiOperation({ summary: "Start paying for an organization plan" })
  @ApiResult(201, "SubscriptionCheckout")
  @ApiZodBody(planBody)
  async checkout(@CurrentUser() user: AuthUser, @Param("slug") slug: string, @Body() body: unknown) {
    return this.subscriptions.checkout(await this.owner(slug), planBody.parse(body).planVersionId, user.id);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @RequirePermission("org.wallet.manage", { orgParam: "slug", orgScopedOnly: true })
  @ApiOperation({ summary: "Cancel at the end of the paid period" })
  @ApiResult(200, "MySubscription")
  async cancel(@Param("slug") slug: string, @Param("id") id: string) {
    return this.subscriptions.cancel(await this.owner(slug), id);
  }

  @Post(":id/change")
  @HttpCode(200)
  @RequirePermission("org.wallet.manage", { orgParam: "slug", orgScopedOnly: true })
  @ApiOperation({ summary: "Upgrade now or schedule a downgrade for the period end" })
  @ApiResult(200, "SubscriptionChange")
  @ApiZodBody(planBody)
  async change(@CurrentUser() user: AuthUser, @Param("slug") slug: string, @Param("id") id: string, @Body() body: unknown) {
    return this.subscriptions.change(await this.owner(slug), id, planBody.parse(body).planVersionId, user.id);
  }
}

const orderStatus = { type: "string", enum: ["CREATED", "PAID", "FAILED", "EXPIRED", "REFUNDED", "PARTIALLY_REFUNDED"] };
const verifiedSchema = objectSchema({ orderId: schemas.str, status: orderStatus, fulfilment: { type: "string", enum: ["FAILED"], description: "Set when the payment is booked but the seller refused to deliver; a refund follows." } }, ["orderId", "status"]);
const downloadLinkSchema = objectSchema({ url: schemas.str, expiresInSec: { type: "integer" }, expiresAt: schemas.isoDate });

const checkoutBody = z.object({ itemType: z.string().trim().min(1).max(40), itemId: z.string().trim().min(1).max(100), couponCode: z.string().trim().min(1).max(64).optional() });
const verifyBody = z.object({ orderId: z.string().uuid(), razorpayOrderId: z.string().min(1).max(100), razorpayPaymentId: z.string().min(1).max(100), signature: z.string().min(1).max(200) }).strict();

/** One-off purchases through Razorpay Orders. Price, discount and commission are computed server-side; the body only names the item. */
@ApiTags("Checkout")
@Controller("checkout")
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly fulfilment: FulfilmentService,
    private readonly prisma: PrismaService,
    @Inject(RAZORPAY_CLIENT) private readonly razorpay: RazorpayClient,
  ) {}

  @AuthenticatedOnly()
  @Idempotent()
  @Post()
  @HttpCode(201)
  @ApiResult(201, "CheckoutStarted")
  @ApiOperation({ summary: "Start buying an item: creates the order and the Razorpay order (requires Idempotency-Key)" })
  @ApiZodBody(checkoutBody)
  @ApiErrorResponse(409, "Idempotency conflict, item not purchasable, or coupon already used.")
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.checkout.create(user.id, checkoutBody.parse(body));
  }

  @AuthenticatedOnly()
  @Post("verify")
  @HttpCode(200)
  @ApiOperation({ summary: "Confirm a Razorpay payment (signature checked); 200 when the order is paid, 202 while the payment is not yet captured" })
  @ApiJsonResponse(200, "The order is paid.", verifiedSchema)
  @ApiJsonResponse(202, "The payment is not captured yet; verify again shortly.", verifiedSchema)
  @ApiZodBody(verifyBody)
  async verify(@CurrentUser() user: AuthUser, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = verifyBody.parse(body);
    const order = await this.prisma.order.findFirst({ where: { id: input.orderId, buyerId: user.id }, select: { id: true, razorpayOrderId: true } });
    if (!order) throw new AppError("ORDER_NOT_FOUND", 404, "Order not found");
    if (!this.razorpay.verifyPaymentSignature({ orderId: input.razorpayOrderId, paymentId: input.razorpayPaymentId, signature: input.signature })) {
      throw new AppError("PAYMENT_SIGNATURE_INVALID", 400, "The payment signature is invalid");
    }
    if (order.razorpayOrderId !== input.razorpayOrderId) throw new AppError("PAYMENT_ORDER_MISMATCH", 422, "This payment does not belong to this order");
    const result = await this.fulfilment.fulfil(order.id, input.razorpayPaymentId, "verify");
    if (result.status !== "PAID") res.status(202);
    return { orderId: result.orderId, status: result.status, ...(result.fulfilment ? { fulfilment: result.fulfilment } : {}) };
  }
}

@ApiTags("Orders")
@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @AuthenticatedOnly()
  @Get()
  @ApiPageResult("Order")
  @ApiOperation({ summary: "My orders, newest first" })
  @ApiPagination()
  list(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.orders.listFor(user.id, parsePage(query));
  }

  @AuthenticatedOnly()
  @Get(":id")
  @ApiResult(200, "Order")
  @ApiOperation({ summary: "One of my orders" })
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.orders.getFor(user.id, id);
  }
}

@ApiTags("Invoices")
@Controller("invoices")
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @AuthenticatedOnly()
  @Get(":id/download")
  @ApiOperation({ summary: "A 5 minute signed URL for the invoice PDF (buyer, seller, or billing.view_any; anyone else gets 404)" })
  @ApiJsonResponse(200, "A signed URL for the PDF.", downloadLinkSchema)
  @ApiErrorResponse(409, "The PDF is not ready yet.")
  download(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.invoices.downloadUrl(user.id, id);
  }
}

@ApiTags("Invoices")
@Controller("credit-notes")
export class CreditNotesController {
  constructor(private readonly invoices: InvoicesService) {}

  @AuthenticatedOnly()
  @Get(":id/download")
  @ApiOperation({ summary: "A 5 minute signed URL for the GST credit note PDF of a refunded order (buyer, seller, or billing.view_any; anyone else gets 404)" })
  @ApiJsonResponse(200, "A signed URL for the PDF.", downloadLinkSchema)
  @ApiErrorResponse(409, "The PDF is not ready yet.")
  download(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.invoices.creditNoteUrl(user.id, id);
  }
}

const refundRequestBody = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();

@ApiTags("Orders")
@Controller("orders")
export class OrderRefundsController {
  constructor(private readonly refunds: RefundRequestsService) {}

  @AuthenticatedOnly()
  @Idempotent()
  @Post(":id/refund-requests")
  @HttpCode(201)
  @ApiResult(201, "Refund")
  @ApiOperation({ summary: "Ask for a full refund of my paid order (requires Idempotency-Key). Finance approves or rejects it." })
  @ApiZodBody(refundRequestBody)
  @ApiErrorResponse(422, "REFUND_NOT_ELIGIBLE: the order is not paid, is outside the refund window, or already has a refund.")
  request(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.refunds.request(user.id, id, refundRequestBody.parse(body).reason);
  }
}
