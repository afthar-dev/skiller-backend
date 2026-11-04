// Public surface of the media module. Other modules import only from here.
// Object storage first: billing imports it while media is still loading (billing <-> media), so it must not wait on anything that imports billing.
export { ObjectStorage, ObjectStorageModule } from "./object-storage";
// Services first, modules last: users and media reference each other, so the module export must not run before the services exist.
export { MediaAttachments } from "./media-attachments";
export { MediaService } from "./media.service";
export type { MediaAssetDto } from "./media.service";
export { PLAYBACK_ACCESS_POLICY, PlaybackPolicies } from "./playback-policy";
export type { PlaybackAccessPolicy } from "./playback-policy";
export { MediaModule } from "./media.module";
export { MediaWorkerModule } from "./media-worker.module";
