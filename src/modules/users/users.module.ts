import { Module, forwardRef } from "@nestjs/common";
import { MediaModule, MediaUrlResolver } from "../media";
import { ModerationModule } from "../moderation";
import { CreatorService } from "./creator.service";
import { FollowsService } from "./follows.service";
import { MeController } from "./me.controller";
import { ProfileRegistrationHandler } from "./profile-registration.handler";
import { ProfilesController } from "./profiles.controller";
import { ProfilesService } from "./profiles.service";
import { RelationsController } from "./relations.controller";

@Module({
  imports: [forwardRef(() => MediaModule), forwardRef(() => ModerationModule)],
  controllers: [MeController, ProfilesController, RelationsController],
  providers: [MediaUrlResolver, ProfilesService, FollowsService, CreatorService, ProfileRegistrationHandler],
  exports: [ProfilesService, FollowsService],
})
export class UsersModule {}
