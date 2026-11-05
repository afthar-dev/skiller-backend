import { Module, OnModuleInit, forwardRef } from "@nestjs/common";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { SignedCursor } from "../../common/http/signed-cursor";
import { EntitlementsModule, UsageRegistry } from "../billing";
import { CoursesModule } from "../courses";
import { ViewerResolver } from "../identity";
import { MediaModule } from "../media";
import { ModerationModule } from "../moderation";
import { UsersModule } from "../users";
import { GigVisibility } from "./gig-visibility";
import { GigsController } from "./gigs.controller";
import { GigsPublicService } from "./gigs-public.service";
import { GigsService } from "./gigs.service";
import { StudioGigsController } from "./studio-gigs.controller";

@Module({
  // forwardRef: module classes arrive through other modules' index files, which may still be loading when this file is evaluated.
  imports: [forwardRef(() => UsersModule), forwardRef(() => MediaModule), forwardRef(() => CoursesModule), forwardRef(() => ModerationModule), EntitlementsModule],
  controllers: [StudioGigsController, GigsController],
  providers: [
    GigsService,
    GigsPublicService,
    GigVisibility,
    ViewerResolver,
    { provide: SignedCursor, inject: [APP_CONFIG], useFactory: (config: AppConfig) => new SignedCursor(config.jwtSecret) },
  ],
  exports: [GigVisibility],
})
export class GigsModule implements OnModuleInit {
  constructor(
    private readonly usage: UsageRegistry,
    private readonly gigs: GigsService,
  ) {}

  /** "My subscription" shows how many of the plan's active gigs are used. */
  onModuleInit() {
    this.usage.register("max_active_gigs", async (owner) => (owner.ownerType === "USER" ? this.gigs.countedFor(owner.ownerId) : null));
  }
}
