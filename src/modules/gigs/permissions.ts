import { definePermissions } from "../rbac/permission.registry";

export const GigPermissions = definePermissions("gig", {
  create: "Sell gigs (creators)",
});
