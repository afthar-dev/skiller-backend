import { definePermissions } from "../rbac/permission.registry";

export const PayoutPermissions = definePermissions("payout", { approve: "Approve payouts" });
export const WalletPermissions = definePermissions("wallet", { view_any: "View any wallet" });
