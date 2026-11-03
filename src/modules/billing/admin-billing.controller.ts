import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { ApiZodBody } from "../../common/openapi/zod-schema";
import { RequireStepUp } from "../identity";
import { RequirePermission } from "../rbac";
import type { MutationMeta } from "../rbac";
import { planLimitsSchema } from "./plan-catalog";
import { PlansService } from "./plans.service";

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
  @ApiOperation({ summary: "All plans with every version" })
  list() {
    return this.plans.listAll();
  }

  @Post()
  @RequirePermission("billing.plans.manage")
  @RequireStepUp()
  @ApiOperation({ summary: "Create a plan with its first version (step-up required)" })
  @ApiZodBody(createPlanSchema)
  create(@CurrentUser() user: AuthUser, @Body() body: unknown, @Req() req: Request) {
    return this.plans.createPlan(user.id, createPlanSchema.parse(body), metaOf(req));
  }

  @Post(":id/versions")
  @RequirePermission("billing.plans.manage")
  @RequireStepUp()
  @ApiOperation({ summary: "Add a plan version. Existing versions never change; subscribers stay on theirs (step-up required)" })
  @ApiZodBody(versionSchema)
  createVersion(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.plans.createVersion(user.id, id, versionSchema.parse(body), metaOf(req));
  }
}
