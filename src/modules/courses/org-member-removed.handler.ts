import { Injectable, OnModuleInit } from "@nestjs/common";
import { EventBus } from "../../common/outbox/event-bus";
import { EnrolmentsService } from "./enrolments.service";

/** A member lost an organization role: end the organization-seat enrolments they no longer qualify for. Idempotent (at-least-once delivery). */
@Injectable()
export class OrgMemberRemovedHandler implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly enrolments: EnrolmentsService,
  ) {}

  onModuleInit() {
    this.bus.on("org.member_removed", async (e) => {
      await this.enrolments.revokeOrgSeats(e.orgId, e.userId);
    });
  }
}
