import { Injectable, OnModuleInit } from "@nestjs/common";
import { EventBus } from "../../common/outbox/event-bus";
import { PermissionService } from "./permission.service";

/** Outbox backstop for role/permission changes: bumps the permission-cache epoch of every affected user. Idempotent. */
@Injectable()
export class PermissionInvalidationHandler implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly permissions: PermissionService,
  ) {}

  onModuleInit() {
    this.bus.on("rbac.permissions_changed", (e) => this.permissions.invalidateUsers(e.userIds));
  }
}
