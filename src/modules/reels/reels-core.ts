import type { Provider } from "@nestjs/common";
import { HashtagTrending } from "./hashtag-trending";
import { InterestEventHandlers } from "./interest-events.handler";
import { InterestsService } from "./interests.service";
import { ReelEventHandlers } from "./reel-events.handler";
import { ReelNotifier } from "./reel-notifier";
import { ReelPublisher } from "./reel-publisher";
import { ReelViewFlusher } from "./reel-view-flusher";

/** What both the API and the worker run for reels: publishing (the daily limit lives here) and the media event handlers the view flusher and the interest profile (engagement events become weights) and the trending hashtags. */
export const REELS_CORE_PROVIDERS: Provider[] = [ReelNotifier, ReelPublisher, ReelEventHandlers, ReelViewFlusher, InterestsService, InterestEventHandlers, HashtagTrending];
