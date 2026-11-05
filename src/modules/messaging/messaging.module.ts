import { Module, forwardRef } from "@nestjs/common";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { SignedCursor } from "../../common/http/signed-cursor";
import { GigsModule } from "../gigs";
import { ModerationModule } from "../moderation";
import { UsersModule } from "../users";
import { ConversationsController } from "./conversations.controller";
import { DEFAULT_STREAM_OPTIONS, MESSAGE_STREAM_OPTIONS, MessageStreamHub } from "./message-stream.hub";
import { MessagingModerationTargets } from "./messaging-moderation-targets";
import { MessagingNotifier } from "./messaging-notifier";
import { MessagingService } from "./messaging.service";

/** One-to-one text messaging, gig inquiries included. Live delivery over SSE (Redis pub/sub) with plain polling endpoints as the fallback. */
@Module({
  // forwardRef: module classes arrive through other modules' index files, which may still be loading when this file is evaluated.
  imports: [forwardRef(() => UsersModule), forwardRef(() => ModerationModule), forwardRef(() => GigsModule)],
  controllers: [ConversationsController],
  providers: [
    MessagingService,
    MessagingNotifier,
    MessagingModerationTargets,
    MessageStreamHub,
    { provide: MESSAGE_STREAM_OPTIONS, useValue: DEFAULT_STREAM_OPTIONS },
    { provide: SignedCursor, inject: [APP_CONFIG], useFactory: (config: AppConfig) => new SignedCursor(config.jwtSecret) },
  ],
})
export class MessagingModule {}
