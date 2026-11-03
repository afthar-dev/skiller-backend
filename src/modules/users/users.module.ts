import { Module } from "@nestjs/common";
import { CreatorService } from "./creator.service";
import { FollowsService } from "./follows.service";
import { MeController } from "./me.controller";
import { ProfileRegistrationHandler } from "./profile-registration.handler";
import { ProfilesController } from "./profiles.controller";
import { ProfilesService } from "./profiles.service";

@Module({
  controllers: [MeController, ProfilesController],
  providers: [ProfilesService, FollowsService, CreatorService, ProfileRegistrationHandler],
  exports: [ProfilesService],
})
export class UsersModule {}
