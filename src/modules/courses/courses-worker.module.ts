import { Module } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { BillingWorkerModule } from "../billing";
import { RbacWorkerModule } from "../rbac";
import { CourseMaintenanceProcessor } from "./course-maintenance.processor";
import { COURSES_CORE_PROVIDERS } from "./courses-core";

/**
 * What the worker process needs from courses: the COURSE sellable (webhook-first fulfilment runs here, not in the API), its refund
 * rule, and the handler that ends organization seats when a member is removed.
 */
@Module({
  imports: [ClockModule, BillingWorkerModule, RbacWorkerModule],
  providers: COURSES_CORE_PROVIDERS,
  exports: [CourseMaintenanceProcessor],
})
export class CoursesWorkerModule {}
