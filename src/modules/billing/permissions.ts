import { definePermissions } from "../rbac/permission.registry";

export const BillingPermissions = definePermissions("billing", {
  "plans.manage": "Create and version subscription plans",
  view_any: "View any user's or organization's billing records",
  refund: "Approve refunds",
  "coupons.manage": "Manage platform-wide coupons",
});
export const FinancePermissions = definePermissions("finance", { view: "View platform finance reports", reconcile: "Run payment reconciliation for a day" });
