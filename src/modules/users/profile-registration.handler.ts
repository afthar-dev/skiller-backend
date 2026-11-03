import { Injectable, OnModuleInit } from "@nestjs/common";
import { EventBus } from "../../common/outbox/event-bus";
import { ProfilesService } from "./profiles.service";

/** Creates the profile for a newly registered user. Idempotent (the outbox is at-least-once); GET /v1/me creates it lazily too. */
@Injectable()
export class ProfileRegistrationHandler implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly profiles: ProfilesService,
  ) {}

  onModuleInit() {
    this.bus.on("user.registered", async (e) => {
      await this.profiles.ensure(e.userId, e.email);
    });
  }
}
