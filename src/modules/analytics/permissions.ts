import { definePermissions } from "../rbac/permission.registry";

export const AnalyticsPermissions = definePermissions("analytics", {
  view: "View the growth dashboards (signups, active users, sales, reels, gigs, campaigns, funnel), export them, and rebuild past days",
});
