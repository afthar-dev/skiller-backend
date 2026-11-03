import { Injectable } from "@nestjs/common";
import type { MediaAsset } from "@prisma/client";
import { PermissionService } from "../rbac/permission.service";

/** Decides whether a user may get a playback token for an asset. Any registered policy returning true allows. */
export interface PlaybackAccessPolicy {
  canPlay(userId: string, asset: MediaAsset): Promise<boolean>;
}

/**
 * Multi-provider token: injects the array of all registered policies. Other modules (Phase 3 enrolment) add theirs with
 * `PlaybackPolicies.register()` in `onModuleInit`, without touching media.
 */
export const PLAYBACK_ACCESS_POLICY = Symbol("PLAYBACK_ACCESS_POLICY");

@Injectable()
export class PlaybackPolicies {
  readonly policies: PlaybackAccessPolicy[] = [];

  register(policy: PlaybackAccessPolicy): void {
    this.policies.push(policy);
  }
}

/** Phase 1 default: the asset's owner, or anyone holding `media.manage_any`. */
@Injectable()
export class OwnerOrAdminPlaybackPolicy implements PlaybackAccessPolicy {
  constructor(private readonly permissions: PermissionService) {}

  async canPlay(userId: string, asset: MediaAsset): Promise<boolean> {
    return asset.ownerId === userId || (await this.permissions.has(userId, "media.manage_any"));
  }
}
