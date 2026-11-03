// Public surface of the media module. Other modules import only from here.
// Services first, modules last: users and media reference each other, so the module export must not run before the services exist.
export { MediaService } from "./media.service";
export type { MediaAssetDto } from "./media.service";
export { PLAYBACK_ACCESS_POLICY, PlaybackPolicies } from "./playback-policy";
export type { PlaybackAccessPolicy } from "./playback-policy";
export { MediaModule } from "./media.module";
