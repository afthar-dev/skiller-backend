import { Module } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { BILLING_CORE_EXPORTS, BILLING_CORE_PROVIDERS } from "./billing.module";

/** Worker process: the webhook processor and the dispatcher other modules register their handlers on. No HTTP surface. */
@Module({ imports: [ClockModule], providers: BILLING_CORE_PROVIDERS, exports: BILLING_CORE_EXPORTS })
export class BillingWorkerModule {}
