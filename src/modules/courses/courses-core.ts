import type { Provider } from "@nestjs/common";
import { COURSE_PROGRESS_READER, NoCourseProgress } from "./course-progress";
import { CourseRefundEligibility } from "./course-refund-eligibility";
import { CourseAccessRules } from "./course-access-rules";
import { CourseMaintenanceProcessor } from "./course-maintenance.processor";
import { CourseSellable } from "./course.sellable";
import { EnrolmentsService } from "./enrolments.service";
import { OrgMemberRemovedHandler } from "./org-member-removed.handler";

/** What both the API and the worker process run for courses: the COURSE sellable and its refund rule, enrolments and the organization event handler. */
export const COURSES_CORE_PROVIDERS: Provider[] = [CourseAccessRules, EnrolmentsService, CourseMaintenanceProcessor, CourseSellable, CourseRefundEligibility, OrgMemberRemovedHandler, { provide: COURSE_PROGRESS_READER, useClass: NoCourseProgress }];
