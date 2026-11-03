import { Body, Controller, Get, Param, Put, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AppError } from "../../common/errors/app-error";
import { ApiErrorResponse } from "../../common/openapi/error-response";
import { ApiZodBody } from "../../common/openapi/zod-schema";
import { RequireStepUp } from "../identity";
import { OrganizationsService } from "../organizations";
import { RequirePermission } from "../rbac";
import type { MutationMeta } from "../rbac";
import { ProfilesService } from "../users";
import type { Owner } from "./entitlements.service";
import { ACCOUNT_NUMBER_PATTERN, IFSC_PATTERN, PAN_PATTERN, VPA_PATTERN } from "./kyc";
import { PayoutAccountsService } from "./payout-accounts.service";

export const metaOf = (req: Request): MutationMeta => ({ ip: req.ip, requestId: (req as Request & { id?: string }).id });

const bankSchema = z
  .object({
    ifsc: z.string().trim().toUpperCase().regex(IFSC_PATTERN, "an 11 character IFSC"),
    accountNumber: z.string().trim().regex(ACCOUNT_NUMBER_PATTERN, "9 to 18 digits"),
    holderName: z.string().trim().min(2).max(100),
  })
  .strict();
const upiSchema = z.object({ vpa: z.string().trim().regex(VPA_PATTERN, "a UPI id such as name@bank") }).strict();
export const payoutAccountSchema = z
  .object({
    type: z.enum(["BANK", "UPI"]),
    bank: bankSchema.optional(),
    upi: upiSchema.optional(),
    pan: z.string().trim().toUpperCase().regex(PAN_PATTERN, "a PAN such as ABCDE1234F"),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.type === "BANK" && (!v.bank || v.upi)) ctx.addIssue({ code: "custom", message: "send `bank` (and no `upi`) for a BANK account", path: ["bank"] });
    if (v.type === "UPI" && (!v.upi || v.bank)) ctx.addIssue({ code: "custom", message: "send `upi` (and no `bank`) for a UPI account", path: ["upi"] });
  });

/** The wallet of the signed-in creator. Payout details are masked everywhere they come back. */
@ApiTags("Wallet")
@Controller("wallet")
export class WalletController {
  constructor(
    private readonly accounts: PayoutAccountsService,
    private readonly profiles: ProfilesService,
  ) {}

  private async owner(user: AuthUser): Promise<Owner> {
    if (!(await this.profiles.isCreator(user.id))) throw new AppError("CREATOR_REQUIRED", 403, "Only creators have a wallet");
    return { ownerType: "USER", ownerId: user.id };
  }

  @AuthenticatedOnly()
  @Put("payout-account")
  @RequireStepUp()
  @ApiOperation({ summary: "Set the payout account (bank or UPI) and PAN. Replaces the current one: it is verified again and payouts pause for 24 hours (step-up required, audited)" })
  @ApiZodBody(payoutAccountSchema)
  @ApiErrorResponse(422, "PAYOUT_ACCOUNT_REJECTED: the payout provider did not accept the details.")
  @ApiErrorResponse(502, "PAYOUT_GATEWAY_ERROR: the payout provider is unavailable.")
  async putAccount(@CurrentUser() user: AuthUser, @Body() body: unknown, @Req() req: Request) {
    const owner = await this.owner(user);
    const input = payoutAccountSchema.parse(body);
    return this.accounts.put(owner, user.id, { ...input, contactName: input.bank?.holderName ?? (await this.profiles.displayNameOf(user.id)) }, metaOf(req));
  }

  @AuthenticatedOnly()
  @Get("payout-account")
  @ApiOperation({ summary: "My current payout account (masked), or null" })
  async getAccount(@CurrentUser() user: AuthUser) {
    return { account: await this.accounts.current(await this.owner(user)) };
  }
}

/** The same wallet for an organization, authorised by `org.manage` on that organization. */
@ApiTags("Wallet")
@Controller("orgs/:slug/wallet")
export class OrgWalletController {
  constructor(
    private readonly accounts: PayoutAccountsService,
    private readonly orgs: OrganizationsService,
    private readonly profiles: ProfilesService,
  ) {}

  private async owner(slug: string): Promise<Owner> {
    const orgId = await this.orgs.idForSlug(slug);
    if (!orgId) throw new AppError("ORG_NOT_FOUND", 404, "Organization not found");
    return { ownerType: "ORG", ownerId: orgId };
  }

  @Put("payout-account")
  @RequirePermission("org.manage", { orgParam: "slug" })
  @RequireStepUp()
  @ApiOperation({ summary: "Set the organization's payout account (step-up required, audited)" })
  @ApiZodBody(payoutAccountSchema)
  async putAccount(@CurrentUser() user: AuthUser, @Param("slug") slug: string, @Body() body: unknown, @Req() req: Request) {
    const owner = await this.owner(slug);
    const input = payoutAccountSchema.parse(body);
    return this.accounts.put(owner, user.id, { ...input, contactName: input.bank?.holderName ?? (await this.profiles.displayNameOf(user.id)) }, metaOf(req));
  }

  @Get("payout-account")
  @RequirePermission("org.manage", { orgParam: "slug" })
  @ApiOperation({ summary: "The organization's current payout account (masked), or null" })
  async getAccount(@Param("slug") slug: string) {
    return { account: await this.accounts.current(await this.owner(slug)) };
  }
}
