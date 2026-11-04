import { Module, forwardRef } from "@nestjs/common";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { SignedCursor } from "../../common/http/signed-cursor";
import { EntitlementsModule } from "../billing";
import { CoursesModule } from "../courses";
import { MediaModule } from "../media";
import { UsersModule } from "../users";
import { CommentsService } from "./comments.service";
import { EngagementController, CommentsController } from "./engagement.controller";
import { EngagementService } from "./engagement.service";
import { ReelViews } from "./reel-views";
import { ReelsController } from "./reels.controller";
import { REELS_CORE_PROVIDERS } from "./reels-core";
import { ReelsService } from "./reels.service";
import { ViewerResolver } from "./viewer";

@Module({
  // forwardRef: module classes arrive through other modules' index files, which may still be loading when this file is evaluated.
  imports: [forwardRef(() => UsersModule), forwardRef(() => MediaModule), forwardRef(() => CoursesModule), EntitlementsModule],
  controllers: [ReelsController, EngagementController, CommentsController],
  providers: [
    ...REELS_CORE_PROVIDERS,
    ReelsService,
    EngagementService,
    CommentsService,
    ReelViews,
    ViewerResolver,
    { provide: SignedCursor, inject: [APP_CONFIG], useFactory: (config: AppConfig) => new SignedCursor(config.jwtSecret) },
  ],
})
export class ReelsModule {}
