import { definePermissions } from "../rbac/permission.registry";

export const CampaignPermissions = definePermissions("campaign", {
  manage: "Create, preview, approve, send, pause and cancel promotional email campaigns",
});
