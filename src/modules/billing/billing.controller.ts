import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { AppError } from "../../common/errors/app-error";
import { ApiZodBody } from "../../common/openapi/zod-schema";
import { OrganizationsService } from "../organizations";
import { RequirePermission } from "../rbac";
import { ProfilesService } from "../users";
import { PlansService } from "./plans.service";
import { SubscriptionsService } from "./subscriptions.service";
import type { Owner } from "./entitlements.service";

const planBody = z.object({ planVersionId: z.string().uuid() }).strict();

@ApiTags("Billing")
@Controller()
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Public()
  @Get("plans")
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
  async me(@CurrentUser() user: AuthUser) {
    return this.subscriptions.me(await this.owner(user));
  }

  @AuthenticatedOnly()
  @Post("checkout")
  @HttpCode(201)
  @ApiOperation({ summary: "Start paying for a plan: creates the Razorpay subscription" })
  @ApiZodBody(planBody)
  async checkout(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.subscriptions.checkout(await this.owner(user), planBody.parse(body).planVersionId);
  }

  @AuthenticatedOnly()
  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel at the end of the paid period" })
  async cancel(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.subscriptions.cancel(await this.owner(user), id);
  }

  @AuthenticatedOnly()
  @Post(":id/change")
  @HttpCode(200)
  @ApiOperation({ summary: "Upgrade now (pay for the new plan) or schedule a downgrade for the period end" })
  @ApiZodBody(planBody)
  async change(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.subscriptions.change(await this.owner(user), id, planBody.parse(body).planVersionId);
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
  async me(@Param("slug") slug: string) {
    return this.subscriptions.me(await this.owner(slug));
  }

  @Post("checkout")
  @HttpCode(201)
  @RequirePermission("org.manage", { orgParam: "slug" })
  @ApiOperation({ summary: "Start paying for an organization plan" })
  @ApiZodBody(planBody)
  async checkout(@Param("slug") slug: string, @Body() body: unknown) {
    return this.subscriptions.checkout(await this.owner(slug), planBody.parse(body).planVersionId);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @RequirePermission("org.manage", { orgParam: "slug" })
  @ApiOperation({ summary: "Cancel at the end of the paid period" })
  async cancel(@Param("slug") slug: string, @Param("id") id: string) {
    return this.subscriptions.cancel(await this.owner(slug), id);
  }

  @Post(":id/change")
  @HttpCode(200)
  @RequirePermission("org.manage", { orgParam: "slug" })
  @ApiOperation({ summary: "Upgrade now or schedule a downgrade for the period end" })
  @ApiZodBody(planBody)
  async change(@Param("slug") slug: string, @Param("id") id: string, @Body() body: unknown) {
    return this.subscriptions.change(await this.owner(slug), id, planBody.parse(body).planVersionId);
  }
}
