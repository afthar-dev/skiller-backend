import { Module } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { BillingWorkerModule } from "../billing";
import { AccountService } from "../identity";
import { ObjectStorageModule } from "../media";
import { NotificationsWorkerModule } from "../notifications";
import { RbacWorkerModule } from "../rbac";
import { ProfilesService } from "../users";
import { CourseMaintenanceProcessor } from "./course-maintenance.processor";
import { COURSES_CORE_PROVIDERS } from "./courses-core";

/**
 * What the worker process needs from courses: the COURSE sellable (webhook-first fulfilment runs here, not in the API), its refund
 * rule, the handler that ends organization seats when a member is removed, and the certificate handlers (issue on completion, revoke on refund).
 */
@Module({
  imports: [ClockModule, BillingWorkerModule, RbacWorkerModule, ObjectStorageModule, NotificationsWorkerModule],
  // Certificates print the learner's name: the worker has no users module, so it builds the small ProfilesService itself (as billing does for invoices).
  providers: [...COURSES_CORE_PROVIDERS, AccountService, ProfilesService],
  exports: [CourseMaintenanceProcessor],
})
export class CoursesWorkerModule {}
