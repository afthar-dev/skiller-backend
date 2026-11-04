import { Module } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { EntitlementsModule } from "../billing";
import { MediaWorkerModule } from "../media";
import { NotificationsWorkerModule } from "../notifications";
import { REELS_CORE_PROVIDERS } from "./reels-core";

/** What the worker process needs from reels: the handlers that publish a reel when its video is ready (or fail it) and notify the creator. */
@Module({
  imports: [ClockModule, EntitlementsModule, MediaWorkerModule, NotificationsWorkerModule],
  providers: [...REELS_CORE_PROVIDERS],
})
export class ReelsWorkerModule {}
