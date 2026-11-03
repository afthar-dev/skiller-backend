import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { AuthUser } from "../../common/auth/auth-user";
import { AppError } from "../../common/errors/app-error";
import { OrgParamResolverRegistry } from "./org-param-resolver";
import { PermissionService } from "./permission.service";
import { REQUIRE_PERMISSION_KEY, type RequirePermissionMeta } from "./require-permission.decorator";

/**
 * Checks @RequirePermission. Never registered on its own: AccessGuard runs it right after AuthGuard so the order does not
 * depend on module import order, and an unauthenticated request always gets 401 before any permission is evaluated.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
    private readonly orgParams: OrgParamResolverRegistry,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<RequirePermissionMeta | undefined>(REQUIRE_PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    if (!meta) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    if (!req.user) throw new AppError("AUTH_REQUIRED", 401, "Authentication required");

    let orgId: string | undefined;
    if (meta.orgParam) {
      const raw = req.params[meta.orgParam];
      if (typeof raw !== "string" || raw.length === 0) throw new AppError("FORBIDDEN", 403, "You do not have permission to do this");
      orgId = await this.orgParams.resolve(meta.orgParam, raw);
    }

    if (!(await this.permissions.has(req.user.id, meta.key, orgId))) {
      throw new AppError("FORBIDDEN", 403, "You do not have permission to do this", { permission: meta.key });
    }
    return true;
  }
}
