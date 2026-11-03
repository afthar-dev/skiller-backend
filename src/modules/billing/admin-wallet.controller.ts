import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination } from "../../common/openapi/zod-schema";
import { RequirePermission } from "../rbac";
import { PayoutAccountsService } from "./payout-accounts.service";

@ApiTags("Admin")
@Controller("admin")
export class AdminWalletController {
  constructor(private readonly accounts: PayoutAccountsService) {}

  @Get("payout-accounts")
  @RequirePermission("wallet.view_any")
  @ApiOperation({ summary: "Payout accounts (masked), newest first. `flagged=true` lists those held for review, e.g. one PAN on two owners" })
  @ApiPagination()
  list(@Query() query: Record<string, unknown>) {
    const status = ["PENDING", "VERIFIED", "FAILED", "INACTIVE"].includes(query.status as string) ? (query.status as "PENDING" | "VERIFIED" | "FAILED" | "INACTIVE") : undefined;
    return this.accounts.listForReview({ flagged: query.flagged === "true", status }, parsePage(query));
  }
}
