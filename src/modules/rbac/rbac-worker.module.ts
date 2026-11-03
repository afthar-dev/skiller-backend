import { Module } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { PermissionInvalidationHandler } from "./permission-invalidation.handler";
import { PermissionService } from "./permission.service";

/** What the worker process needs from RBAC: the outbox handler that invalidates permission caches. */
@Module({ imports: [ClockModule], providers: [PermissionService, PermissionInvalidationHandler] })
export class RbacWorkerModule {}
