import type { RoleScope } from "@prisma/client";

export interface SystemRoleDef {
  key: string;
  name: string;
  scope: RoleScope;
  /** Granted when the role is first created. `super_admin` is special: sync keeps it holding every key. */
  permissions: readonly string[];
}

export const SUPER_ADMIN_ROLE_KEY = "super_admin";
export const MEMBER_ROLE_KEY = "member";

const MEMBER = ["media.upload", "org.create"] as const;

export const SYSTEM_ROLES: readonly SystemRoleDef[] = [
  { key: MEMBER_ROLE_KEY, name: "Member", scope: "PLATFORM", permissions: MEMBER },
  // Later phases add course/gig keys to creator.
  { key: "creator", name: "Creator", scope: "PLATFORM", permissions: [...MEMBER, "course.create"] },
  { key: "org_owner", name: "Organization owner", scope: "ORG", permissions: ["org.manage", "org.invite", "org.wallet.manage"] },
  // Invitable org roles; they carry no permissions yet (Phase 2 adds course/gig keys). Membership itself is the UserRole row.
  { key: "org_instructor", name: "Organization instructor", scope: "ORG", permissions: [] },
  { key: "org_learner", name: "Organization learner", scope: "ORG", permissions: [] },
  { key: "moderator", name: "Moderator", scope: "PLATFORM", permissions: ["user.view", "media.manage_any", "course.review", "course.manage_any"] },
  { key: "support", name: "Support", scope: "PLATFORM", permissions: ["user.view", "user.revoke_sessions", "audit.view"] },
  {
    key: "finance_admin",
    name: "Finance admin",
    scope: "PLATFORM",
    permissions: ["user.view", "audit.view", "finance.view", "billing.view_any", "billing.refund", "payout.approve", "wallet.view_any", "finance.reconcile", "billing.coupons.manage"],
  },
  { key: SUPER_ADMIN_ROLE_KEY, name: "Super admin", scope: "PLATFORM", permissions: [] },
];
