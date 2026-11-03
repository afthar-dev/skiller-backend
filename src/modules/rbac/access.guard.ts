import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { AuthGuard } from "../identity";
import { PermissionGuard } from "./permission.guard";

/**
 * The single global authN + authZ guard. Order is fixed here (authenticate, then check permission) instead of depending on
 * which module registers its APP_GUARD first.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly auth: AuthGuard,
    private readonly permission: PermissionGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!(await this.auth.canActivate(context))) return false;
    return this.permission.canActivate(context);
  }
}
