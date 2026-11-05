import { definePermissions } from "../rbac/permission.registry";

export const ModerationPermissions = definePermissions("moderation", {
  review: "Review reports: see the moderation queue, uphold (remove content, strike the author) or dismiss",
});
