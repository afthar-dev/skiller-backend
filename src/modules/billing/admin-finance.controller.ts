import { Body, Controller, Get, HttpCode, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AppError } from "../../common/errors/app-error";
import { parsePage } from "../../common/http/pagination";
import { ApiErrorResponse } from "../../common/openapi/error-response";
import { ApiPageResult, ApiResult } from "../../common/openapi/money";
import { ApiPagination, ApiZodBody, ApiZodQuery } from "../../common/openapi/zod-schema";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit";
import { RequireStepUp } from "../identity";
import { RequirePermission } from "../rbac";
import { AdminFinanceService } from "./admin-finance.service";
import { DATE_PATTERN, istWindow } from "./ist";
import { OrdersService } from "./orders.service";
import { ReconciliationService } from "./reconciliation.service";
import { metaOf } from "./wallet.controller";

const day = z.string().regex(DATE_PATTERN, "a calendar day, YYYY-MM-DD (India time)");
const summaryQuery = z.object({ from: day.optional(), to: day.optional() }).strict();
const runBody = z.object({ date: day }).strict();

@ApiTags("Admin")
@Controller("admin/finance")
export class AdminFinanceController {
  constructor(
    private readonly finance: AdminFinanceService,
    private readonly reconciliation: ReconciliationService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get("summary")
  @RequirePermission("finance.view")
  @ApiResult(200, "FinanceSummary")
  @ApiOperation({ summary: "GMV, platform revenue, tax payable, refunds, payouts and paid subscribers for a range of IST days (default: the last 30). Amounts are decimal strings of paise and equal the ledger sums." })
  @ApiZodQuery(summaryQuery)
  @ApiErrorResponse(400, "FINANCE_RANGE_INVALID: bad dates, from after to, or more than 366 days.")
  summary(@Query() query: Record<string, unknown>) {
    const { from, to } = summaryQuery.parse({ from: query.from, to: query.to });
    return this.finance.summary(from, to);
  }

  @Get("reconciliation")
  @RequirePermission("finance.view")
  @ApiPageResult("ReconciliationRun")
  @ApiOperation({ summary: "Nightly reconciliation runs, newest day first (details list every mismatch)" })
  @ApiPagination()
  listRuns(@Query() query: Record<string, unknown>) {
    return this.reconciliation.list(parsePage(query));
  }

  @Post("reconciliation/run")
  @HttpCode(200)
  @RequirePermission("finance.reconcile")
  @RequireStepUp()
  @ApiResult(200, "ReconciliationRun")
  @ApiOperation({ summary: "Reconcile one IST day now (the same checks as the 02:00 job; rerunning a day updates its run). Step-up required, audited." })
  @ApiZodBody(runBody)
  @ApiErrorResponse(400, "RECONCILIATION_DATE_INVALID: not a calendar day.")
  async run(@CurrentUser() user: AuthUser, @Body() body: unknown, @Req() req: Request) {
    const { date } = runBody.parse(body);
    const run = await this.reconciliation.run(date);
    await this.prisma.$transaction((tx) =>
      this.audit.record(tx, { actorId: user.id, action: "finance.reconciliation.run", targetType: "reconciliation_run", targetId: run.id, before: null, after: { date: run.date, status: run.status }, ...metaOf(req) }),
    );
    return run;
  }
}

const orderStatus = z.enum(["CREATED", "PAID", "FAILED", "EXPIRED", "REFUNDED", "PARTIALLY_REFUNDED"]);
const ordersQuery = z
  .object({
    status: orderStatus.optional(),
    buyerId: z.string().min(1).max(100).optional(),
    sellerOwnerId: z.string().min(1).max(100).optional(),
    razorpayPaymentId: z.string().min(1).max(100).optional(),
    from: day.optional(),
    to: day.optional(),
  })
  .strict();
const subscriptionsQuery = z
  .object({
    status: z.enum(["INCOMPLETE", "TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED", "EXPIRED"]).optional(),
    ownerType: z.enum(["USER", "ORG"]).optional(),
    ownerId: z.string().min(1).max(100).optional(),
    planKey: z.string().min(1).max(60).optional(),
    from: day.optional(),
    to: day.optional(),
  })
  .strict();

const FILTER_KEYS = ["status", "buyerId", "sellerOwnerId", "razorpayPaymentId", "ownerType", "ownerId", "planKey", "from", "to"];
const filtersOf = (query: Record<string, unknown>) => Object.fromEntries(FILTER_KEYS.filter((k) => query[k] !== undefined).map((k) => [k, query[k]]));

const window = (from?: string, to?: string) => {
  try {
    return istWindow(from, to);
  } catch {
    throw new AppError("VALIDATION_FAILED", 400, "from and to must be calendar days, YYYY-MM-DD", { fields: ["from", "to"] });
  }
};

@ApiTags("Admin")
@Controller("admin")
export class AdminOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly finance: AdminFinanceService,
  ) {}

  @Get("orders")
  @RequirePermission("billing.view_any")
  @ApiPageResult("AdminOrder")
  @ApiOperation({ summary: "Every order, newest first, filtered by status, buyer, seller, Razorpay payment id or IST day range" })
  @ApiZodQuery(ordersQuery)
  @ApiPagination()
  listOrders(@Query() query: Record<string, unknown>) {
    const { from, to, ...filter } = ordersQuery.parse(filtersOf(query));
    return this.orders.listAll({ ...filter, createdAt: window(from, to) }, parsePage(query));
  }

  @Get("subscriptions")
  @RequirePermission("billing.view_any")
  @ApiOperation({ summary: "Every subscription, newest first, filtered by status, owner, plan or IST day range" })
  @ApiZodQuery(subscriptionsQuery)
  @ApiPagination()
  @ApiPageResult("AdminSubscription")
  listSubscriptions(@Query() query: Record<string, unknown>) {
    const { from, to, ...filter } = subscriptionsQuery.parse(filtersOf(query));
    return this.finance.listSubscriptions({ ...filter, createdAt: window(from, to) }, parsePage(query));
  }
}
