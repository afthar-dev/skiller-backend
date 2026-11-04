import { Module } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { PermissionInvalidationHandler } from "./permission-invalidation.handler";
import { PermissionService } from "./permission.service";
import { PlatformRoleDirectory } from "./platform-role-directory";

/** What the worker process needs from RBAC: the outbox handler that invalidates permission caches, and the role directory (finance alerts). */
@Module({ imports: [ClockModule], providers: [PermissionService, PermissionInvalidationHandler, PlatformRoleDirectory], exports: [PlatformRoleDirectory, PermissionService] })
export class RbacWorkerModule {}
