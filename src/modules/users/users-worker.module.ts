import { Module } from "@nestjs/common";
import { AccountService, UserStatusCache } from "../identity";
import { MediaUrlResolver } from "../media";
import { ProfileRegistrationHandler } from "./profile-registration.handler";
import { ProfilesService } from "./profiles.service";

/** What the worker process needs from users: the user.registered handler that creates profiles. */
@Module({ providers: [MediaUrlResolver, AccountService, UserStatusCache, ProfilesService, ProfileRegistrationHandler] })
export class UsersWorkerModule {}
