import { Module } from "@nestjs/common";
import { AccountService, UserStatusCache } from "../identity";
import { ProfileRegistrationHandler } from "./profile-registration.handler";
import { ProfilesService } from "./profiles.service";

/** What the worker process needs from users: the user.registered handler that creates profiles. */
@Module({ providers: [AccountService, UserStatusCache, ProfilesService, ProfileRegistrationHandler] })
export class UsersWorkerModule {}
