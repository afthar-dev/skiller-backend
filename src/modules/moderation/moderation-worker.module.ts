import { Module } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { ModerationTargetRegistry } from "./moderation-target";
import { PostingRestrictions } from "./posting-restrictions";
import { UserBlocks } from "./user-blocks";

/** What the worker process needs from moderation: the target registry content owners register with, and the block / restriction lookups. Decisions happen in the API. */
@Module({
  imports: [ClockModule],
  providers: [ModerationTargetRegistry, UserBlocks, PostingRestrictions],
  exports: [ModerationTargetRegistry, UserBlocks, PostingRestrictions],
})
export class ModerationWorkerModule {}
