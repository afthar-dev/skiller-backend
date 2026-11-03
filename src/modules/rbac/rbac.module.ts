import { Global, Injectable, Module, OnApplicationBootstrap } from "@nestjs/common";
import { APP_GUARD, ApplicationConfig, DiscoveryModule, DiscoveryService } from "@nestjs/core";
import { AccessGuard } from "./access.guard";
import { PermissionGuard } from "./permission.guard";
import { PermissionService } from "./permission.service";
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
  providers: [PermissionService, PermissionGuard, RouteGuardCheck, { provide: APP_GUARD, useClass: AccessGuard }],
  exports: [PermissionService, PermissionGuard],
})
export class RbacModule {}
