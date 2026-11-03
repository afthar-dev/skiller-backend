import { Module } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { NotificationsWorkerModule } from "../notifications";
import { RbacWorkerModule } from "../rbac";
import { AccountService } from "../identity";
import { ObjectStorageModule } from "../media";
import { ProfilesService } from "../users";
import { WalletWorkerModule } from "../wallet";
import { BILLING_CORE_EXPORTS, BILLING_CORE_PROVIDERS } from "./billing.module";
import { EntitlementsModule } from "./entitlements.module";

/** Worker process: the webhook processor, the subscription handlers and maintenance job, and the dispatcher other modules register on. No HTTP surface. */
@Module({
  imports: [ClockModule, EntitlementsModule, ObjectStorageModule, WalletWorkerModule, NotificationsWorkerModule, RbacWorkerModule],
  // Invoices print buyer and seller names: the worker has no users module, so it builds the two small services itself (as notifications does).
  providers: [...BILLING_CORE_PROVIDERS, AccountService, ProfilesService],
  exports: BILLING_CORE_EXPORTS,
})
export class BillingWorkerModule {}
