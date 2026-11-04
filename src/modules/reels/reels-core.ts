import type { Provider } from "@nestjs/common";
import { ReelEventHandlers } from "./reel-events.handler";
import { ReelNotifier } from "./reel-notifier";
import { ReelPublisher } from "./reel-publisher";

/** What both the API and the worker run for reels: publishing (the daily limit lives here) and the media event handlers. */
export const REELS_CORE_PROVIDERS: Provider[] = [ReelNotifier, ReelPublisher, ReelEventHandlers];
