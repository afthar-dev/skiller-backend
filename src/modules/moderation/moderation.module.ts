import { Module } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { AdminModerationController, ReportsController } from "./moderation.controller";
import { ModerationService } from "./moderation.service";
import { ModerationTargetRegistry } from "./moderation-target";
import { PostingRestrictions } from "./posting-restrictions";
import { UserBlocks } from "./user-blocks";

/**
 * Reports, strikes, posting restrictions, blocks and mutes. Owners of reportable content (reels, course reviews and Q&A) register a ModerationTarget with
 * the registry; this module never reads their tables. Settings, audit and notifications come from global modules.
 */
@Module({
  imports: [ClockModule],
  controllers: [ReportsController, AdminModerationController],
  providers: [ModerationTargetRegistry, UserBlocks, PostingRestrictions, ModerationService],
  exports: [ModerationTargetRegistry, UserBlocks, PostingRestrictions, ModerationService],
})
export class ModerationModule {}
