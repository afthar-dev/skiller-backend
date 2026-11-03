import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiErrorResponse } from "../../common/openapi/error-response";
import { ApiPagination, ApiZodBody } from "../../common/openapi/zod-schema";
import { RequireStepUp } from "../identity";
import { RequirePermission } from "../rbac";
import { PayoutAccountsService } from "./payout-accounts.service";
import { PayoutsService } from "./payouts.service";
import { metaOf } from "./wallet.controller";

const payoutStatusSchema = z.enum(["REQUESTED", "APPROVED", "PROCESSING", "PAID", "REJECTED", "REVERSED", "FAILED"]);
const rejectSchema = z.object({ note: z.string().trim().min(1).max(500).optional() }).strict();
const listSchema = z.object({ status: payoutStatusSchema.optional(), ownerType: z.enum(["USER", "ORG"]).optional(), ownerId: z.string().min(1).max(100).optional() });

@ApiTags("Admin")
@Controller("admin")
export class AdminWalletController {
  constructor(
    private readonly accounts: PayoutAccountsService,
    private readonly payouts: PayoutsService,
  ) {}

  @Get("payout-accounts")
  @RequirePermission("wallet.view_any")
  @ApiOperation({ summary: "Payout accounts (masked), newest first. `flagged=true` lists those held for review, e.g. one PAN on two owners" })
  @ApiPagination()
  listAccounts(@Query() query: Record<string, unknown>) {
    const status = ["PENDING", "VERIFIED", "FAILED", "INACTIVE"].includes(query.status as string) ? (query.status as "PENDING" | "VERIFIED" | "FAILED" | "INACTIVE") : undefined;
    return this.accounts.listForReview({ flagged: query.flagged === "true", status }, parsePage(query));
  }

  @Get("payouts")
  @RequirePermission("wallet.view_any")
  @ApiOperation({ summary: "Payouts, newest first, optionally by status and owner" })
  @ApiPagination()
  list(@Query() query: Record<string, unknown>) {
    const { status, ownerType, ownerId } = listSchema.parse({ status: query.status, ownerType: query.ownerType, ownerId: query.ownerId });
    return this.payouts.list({ status, ownerType, ownerId }, parsePage(query));
  }

  @Get("payouts/:id")
  @RequirePermission("wallet.view_any")
  @ApiOperation({ summary: "One payout" })
  get(@Param("id") id: string) {
    return this.payouts.get(id);
  }

  @Post("payouts/:id/approve")
  @HttpCode(200)
  @RequirePermission("payout.approve")
  @RequireStepUp()
  @ApiOperation({ summary: "Approve a payout: it is sent to RazorpayX by a background job (step-up required, audited). Repeating it never sends twice." })
  @ApiErrorResponse(409, "PAYOUT_NOT_PENDING: the payout was already decided.")
  approve(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.payouts.approve(user.id, id, metaOf(req));
  }

  @Post("payouts/:id/reject")
  @HttpCode(200)
  @RequirePermission("payout.approve")
  @RequireStepUp()
  @ApiOperation({ summary: "Reject a payout request: the locked funds return to the seller's available balance (step-up required, audited)" })
  @ApiZodBody(rejectSchema)
  @ApiErrorResponse(409, "PAYOUT_NOT_PENDING: the payout was already decided.")
  reject(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.payouts.reject(user.id, id, rejectSchema.parse(body ?? {}).note, metaOf(req));
  }
}
