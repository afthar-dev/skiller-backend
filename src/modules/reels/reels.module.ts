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
import { FeedsController } from "./feeds.controller";
import { HashtagReelsService } from "./hashtag-reels.service";
import { HashtagsController, ReelSearchController } from "./hashtags.controller";
import { ReelSearchService } from "./reel-search.service";
import { FeedsService } from "./feeds.service";
import { ReelVisibility } from "./reel-visibility";
import { ReelViewTracker } from "./reel-view-tracker";
import { ReelViews } from "./reel-views";
import { ReelViewsController } from "./reel-views.controller";
import { ReelsController } from "./reels.controller";
import { REELS_CORE_PROVIDERS } from "./reels-core";
import { ReelsService } from "./reels.service";
import { ViewerResolver } from "./viewer";

@Module({
  // forwardRef: module classes arrive through other modules' index files, which may still be loading when this file is evaluated.
  imports: [forwardRef(() => UsersModule), forwardRef(() => MediaModule), forwardRef(() => CoursesModule), EntitlementsModule],
  controllers: [FeedsController, ReelSearchController, HashtagsController, ReelsController, EngagementController, CommentsController, ReelViewsController],
  providers: [
    ...REELS_CORE_PROVIDERS,
    ReelsService,
    EngagementService,
    CommentsService,
    ReelViews,
    ReelVisibility,
    FeedsService,
    HashtagReelsService,
    ReelSearchService,
    ReelViewTracker,
    ViewerResolver,
    { provide: SignedCursor, inject: [APP_CONFIG], useFactory: (config: AppConfig) => new SignedCursor(config.jwtSecret) },
  ],
})
export class ReelsModule {}
