import { definePermissions } from "../rbac/permission.registry";

export const ReelPermissions = definePermissions("reel", {
  create: "Post reels (creators)",
});
