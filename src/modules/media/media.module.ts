import { Module, OnModuleInit, forwardRef } from "@nestjs/common";
import { EntitlementsModule, UsageRegistry } from "../billing";
import { UsersModule } from "../users";
import { MediaLifecycle } from "./media-lifecycle";
import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";
import { OwnerOrAdminPlaybackPolicy, PLAYBACK_ACCESS_POLICY, PlaybackPolicies } from "./playback-policy";
import { PlaybackService } from "./playback.service";
import { R2Client } from "./r2.client";

/** API side of media: upload sessions and `attach`. The processors live in MediaWorkerModule (worker process only). */
@Module({
  // users -> media (profile avatar/banner attach) and media -> users (isCreator): a module-level cycle only, no provider cycle.
  imports: [forwardRef(() => UsersModule), EntitlementsModule],
  controllers: [MediaController],
  providers: [
    R2Client,
    MediaLifecycle,
    MediaService,
    PlaybackService,
    PlaybackPolicies,
    OwnerOrAdminPlaybackPolicy,
    // The live array of registered policies (any true allows); Phase 3 adds its enrolment policy via PlaybackPolicies.register().
    { provide: PLAYBACK_ACCESS_POLICY, useFactory: (registry: PlaybackPolicies) => registry.policies, inject: [PlaybackPolicies] },
  ],
  exports: [MediaService, PlaybackPolicies],
})
export class MediaModule implements OnModuleInit {
  constructor(
    private readonly policies: PlaybackPolicies,
    private readonly ownerOrAdmin: OwnerOrAdminPlaybackPolicy,
    private readonly usage: UsageRegistry,
    private readonly media: MediaService,
  ) {}

  onModuleInit() {
    this.policies.register(this.ownerOrAdmin);
    this.usage.register("storage_gb", async (owner) => (owner.ownerType === "USER" ? this.media.storageUsedBytes(owner.ownerId) : null));
  }
}
