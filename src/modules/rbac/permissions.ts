import { definePermissions, permissionRegistry } from "./permission.registry";

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
});
export const SettingsPermissions = definePermissions("settings", { manage: "Manage platform settings" });
export const FlagsPermissions = definePermissions("flags", { manage: "Manage feature flags" });
export const NotificationPermissions = definePermissions("notification", { view: "View notification delivery status" });

export const PHASE_1_PERMISSION_KEYS: readonly string[] = permissionRegistry.all().map((p) => p.key);
