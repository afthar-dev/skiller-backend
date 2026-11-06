import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import type { AuthUser } from "../../common/auth/auth-user";
import { ActivityTracker } from "../../common/activity/activity-tracker";
import { AuthGuard } from "../identity";
import { PermissionGuard } from "./permission.guard";

/**
 * The single global authN + authZ guard. Order is fixed here (authenticate, then check permission) instead of depending on
 * which module registers its APP_GUARD first. A request that authenticated counts the member as active today (ActivityTracker: fire-and-forget,
 * can never fail the request).
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly auth: AuthGuard,
    private readonly permission: PermissionGuard,
    private readonly activity: ActivityTracker,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!(await this.auth.canActivate(context))) return false;
    const user = context.switchToHttp().getRequest<Request & { user?: AuthUser }>().user;
    if (user) this.activity.record(user.id);
    return this.permission.canActivate(context);
  }
}
