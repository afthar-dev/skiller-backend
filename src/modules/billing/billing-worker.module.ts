import { Module } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { NotificationsWorkerModule } from "../notifications";
import { RbacWorkerModule } from "../rbac";
import { WalletWorkerModule } from "../wallet";
import { BILLING_CORE_EXPORTS, BILLING_CORE_PROVIDERS } from "./billing.module";
import { EntitlementsModule } from "./entitlements.module";

/** Worker process: the webhook processor, the subscription handlers and maintenance job, and the dispatcher other modules register on. No HTTP surface. */
@Module({
  imports: [ClockModule, EntitlementsModule, WalletWorkerModule, NotificationsWorkerModule, RbacWorkerModule],
  providers: BILLING_CORE_PROVIDERS,
  exports: BILLING_CORE_EXPORTS,
})
export class BillingWorkerModule {}
