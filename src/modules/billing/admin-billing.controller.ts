import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiErrorResponse } from "../../common/openapi/error-response";
import { ApiPageResult, ApiResult } from "../../common/openapi/money";
import { ApiPagination, ApiZodBody, ApiZodQuery } from "../../common/openapi/zod-schema";
import { RequireStepUp } from "../identity";
import { RequirePermission } from "../rbac";
import type { MutationMeta } from "../rbac";
import { DATE_PATTERN, istWindow } from "./ist";
import { planLimitsSchema } from "./plan-catalog";
import { PlansService } from "./plans.service";
import { RefundRequestsService } from "./refund-requests.service";

const metaOf = (req: Request): MutationMeta => ({ ip: req.ip, requestId: (req as Request & { id?: string }).id });

const versionSchema = z
  .object({
    pricePaise: z.string().regex(/^(0|[1-9]\d{0,14})$/, "integer paise as a string"),
    interval: z.enum(["MONTH", "YEAR"]),
    commissionBps: z.number().int().min(0).max(10_000),
    limits: planLimitsSchema,
  })
  .strict();
const createPlanSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, "lower-case letters, digits and underscores, starting with a letter"),
    name: z.string().trim().min(1).max(100),
    audience: z.enum(["CREATOR", "ORG"]),
    version: versionSchema,
  })
  .strict();

@ApiTags("Admin")
@Controller("admin/plans")
export class AdminBillingController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @RequirePermission("billing.plans.manage")
  @ApiResult(200, "PlanList")
  @ApiOperation({ summary: "All plans with every version" })
  list() {
    return this.plans.listAll();
  }

  @Post()
  @RequirePermission("billing.plans.manage")
  @RequireStepUp()
  @ApiOperation({ summary: "Create a plan with its first version (step-up required)" })
  @ApiZodBody(createPlanSchema)
  @ApiResult(201, "Plan")
  create(@CurrentUser() user: AuthUser, @Body() body: unknown, @Req() req: Request) {
    return this.plans.createPlan(user.id, createPlanSchema.parse(body), metaOf(req));
  }

  @Post(":id/versions")
  @RequirePermission("billing.plans.manage")
  @RequireStepUp()
  @ApiOperation({ summary: "Add a plan version. Existing versions never change; subscribers stay on theirs (step-up required)" })
  @ApiZodBody(versionSchema)
  @ApiResult(201, "PlanVersion")
  createVersion(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.plans.createVersion(user.id, id, versionSchema.parse(body), metaOf(req));
  }
}

const refundStatusSchema = z.enum(["REQUESTED", "APPROVED", "PROCESSING", "PROCESSED", "REJECTED", "FAILED"]);
const refundListSchema = z.object({ status: refundStatusSchema.optional(), orderId: z.string().min(1).max(100).optional(), from: z.string().regex(DATE_PATTERN).optional(), to: z.string().regex(DATE_PATTERN).optional() });
const rejectSchema = z.object({ note: z.string().trim().min(1).max(500).optional() }).strict();

@ApiTags("Admin")
@Controller("admin/refunds")
export class AdminRefundsController {
  constructor(private readonly refunds: RefundRequestsService) {}

  @Get()
  @RequirePermission("billing.refund")
  @ApiPageResult("Refund")
  @ApiOperation({ summary: "Refunds, newest first, optionally by status, order and IST day range" })
  @ApiZodQuery(refundListSchema)
  @ApiPagination()
  list(@Query() query: Record<string, unknown>) {
    const { status, orderId, from, to } = refundListSchema.parse({ status: query.status, orderId: query.orderId, from: query.from, to: query.to });
    return this.refunds.list({ status, orderId, createdAt: istWindow(from, to) }, parsePage(query));
  }

  @Post(":id/approve")
  @HttpCode(200)
  @RequirePermission("billing.refund")
  @RequireStepUp()
  @ApiResult(200, "Refund")
  @ApiOperation({ summary: "Approve a refund request and start the Razorpay refund (step-up required, audited). Repeating it retries a start that failed." })
  @ApiErrorResponse(409, "REFUND_NOT_PENDING: the refund was already decided.")
  @ApiErrorResponse(502, "REFUND_GATEWAY_ERROR: Razorpay is unavailable; approve again to retry.")
  approve(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.refunds.approve(user.id, id, metaOf(req));
  }

  @Post(":id/reject")
  @HttpCode(200)
  @RequirePermission("billing.refund")
  @RequireStepUp()
  @ApiResult(200, "Refund")
  @ApiOperation({ summary: "Reject a refund request; the buyer is told (step-up required, audited)" })
  @ApiZodBody(rejectSchema)
  @ApiErrorResponse(409, "REFUND_NOT_PENDING: the refund was already decided.")
  reject(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.refunds.reject(user.id, id, rejectSchema.parse(body ?? {}).note, metaOf(req));
  }
}
