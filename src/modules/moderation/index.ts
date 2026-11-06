// Public surface of the moderation module. Other modules import only from here.
// Leaf services first (no imports of other modules): users imports UserBlocks while this index is still loading, so it must come before anything that reaches back.
export { UserBlocks } from "./user-blocks";
export type { ViewerRelations, RelationPage } from "./user-blocks";
export { OpenReports } from "./open-reports";
export { PostingRestrictions, postingRestricted } from "./posting-restrictions";
export { ModerationTargetRegistry } from "./moderation-target";
export type { ModerationTarget } from "./moderation-target";
export { ModerationService } from "./moderation.service";
export { ModerationModule } from "./moderation.module";
export { ModerationWorkerModule } from "./moderation-worker.module";
export { ModerationMetricsProvider } from "./moderation-metrics.provider";
