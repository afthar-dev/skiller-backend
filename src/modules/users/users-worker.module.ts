import { Module } from "@nestjs/common";
import { ProfileRegistrationHandler } from "./profile-registration.handler";
import { ProfilesService } from "./profiles.service";

/** What the worker process needs from users: the user.registered handler that creates profiles. */
@Module({ providers: [ProfilesService, ProfileRegistrationHandler] })
export class UsersWorkerModule {}
