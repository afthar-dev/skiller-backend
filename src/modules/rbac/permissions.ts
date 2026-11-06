import { definePermissions, permissionRegistry } from "./permission.registry";
// Other modules define their own keys next to their code; importing them here registers them in the default registry.
import "../billing/permissions";
import "../wallet/permissions";
import "../courses/permissions";
import "../reels/permissions";
import "../gigs/permissions";
import "../moderation/permissions";
import "../growth/permissions";
import "../analytics/permissions";

// Phase-1 permission keys. Later phases add their own definePermissions() calls next to their modules.
export const ProfilePermissions = definePermissions("profile", { update_any: "Edit any user's profile" });
export const UserPermissions = definePermissions("user", {
  view: "View users",
  suspend: "Suspend and unsuspend users",
  revoke_sessions: "Revoke a user's sessions",
});
export const RbacPermissions = definePermissions("rbac", { view: "View roles and permissions", manage: "Create, edit and delete roles" });
export const RoleAdminPermissions = definePermissions("role", { grant: "Grant and revoke roles for users" });
export const AuditPermissions = definePermissions("audit", { view: "View the audit log" });
export const MediaPermissions = definePermissions("media", { upload: "Upload media", manage_any: "Manage anyone's media" });
export const OrgPermissions = definePermissions("org", {
  create: "Create organizations",
  manage: "Manage an organization",
  invite: "Invite members to an organization",
  "wallet.manage": "Move an organization's money: payout account, payouts, subscription payments (only held as an org-scoped grant)",
});
export const SettingsPermissions = definePermissions("settings", { manage: "Manage platform settings" });
export const FlagsPermissions = definePermissions("flags", { manage: "Manage feature flags" });
export const NotificationPermissions = definePermissions("notification", { view: "View notification delivery status" });

export const PLATFORM_PERMISSION_KEYS: readonly string[] = permissionRegistry.all().map((p) => p.key);
