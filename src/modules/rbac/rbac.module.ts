import { Global, Injectable, Module, OnApplicationBootstrap } from "@nestjs/common";
import { APP_GUARD, ApplicationConfig, DiscoveryModule, DiscoveryService } from "@nestjs/core";
import { AccessGuard } from "./access.guard";
import { OrgParamResolverRegistry } from "./org-param-resolver";
import { PermissionInvalidationHandler } from "./permission-invalidation.handler";
import { PermissionGuard } from "./permission.guard";
import { PlatformRoleDirectory } from "./platform-role-directory";
import { MEMBER_ROLE_GRANTER } from "../identity";
import { PermissionService } from "./permission.service";
import { RbacMemberRoleGranter } from "./rbac-member-role-granter";
import { RolesController } from "./roles.controller";
import { RolesService } from "./roles.service";
import { assertAllRoutesGuarded } from "./route-guard-check";
import "./permissions";

/** Refuses to start the app when a route has no @RequirePermission / @Public / @AuthenticatedOnly. */
@Injectable()
export class RouteGuardCheck implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly appConfig: ApplicationConfig,
  ) {}

  onApplicationBootstrap() {
    const controllers = this.discovery
      .getControllers()
      .map((w) => w.metatype)
      .filter((m): m is NonNullable<typeof m> => typeof m === "function");
    assertAllRoutesGuarded(controllers, this.appConfig.getGlobalPrefix());
  }
}

// Global so any module can use @RequirePermission without importing this one.
@Global()
@Module({
  imports: [DiscoveryModule],
  controllers: [RolesController],
  providers: [
    PermissionService,
    OrgParamResolverRegistry,
    PermissionGuard,
    RolesService,
    PlatformRoleDirectory,
    PermissionInvalidationHandler,
    RouteGuardCheck,
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: MEMBER_ROLE_GRANTER, useClass: RbacMemberRoleGranter },
  ],
  exports: [PermissionService, OrgParamResolverRegistry, PermissionGuard, RolesService, PlatformRoleDirectory, MEMBER_ROLE_GRANTER],
})
export class RbacModule {}
