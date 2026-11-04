import type { Provider } from "@nestjs/common";
import { COURSE_PROGRESS_READER } from "./course-progress";
import { CourseRefundEligibility } from "./course-refund-eligibility";
import { CourseAccessRules } from "./course-access-rules";
import { CourseMaintenanceProcessor } from "./course-maintenance.processor";
import { CertificateEventHandlers } from "./certificate-events.handler";
import { CertificatesService } from "./certificates.service";
import { CoursePopularity } from "./course-popularity";
import { CourseSearchHandlers } from "./course-search.handlers";
import { CourseSellable } from "./course.sellable";
import { EnrolmentsService } from "./enrolments.service";
import { OrgMemberRemovedHandler } from "./org-member-removed.handler";
import { ProgressService } from "./progress.service";

/** What both the API and the worker process run for courses: the COURSE sellable and its refund rule, enrolments and the organization event handler. */
export const COURSES_CORE_PROVIDERS: Provider[] = [CourseAccessRules, EnrolmentsService, CourseMaintenanceProcessor, CourseSellable, CourseRefundEligibility, OrgMemberRemovedHandler, ProgressService, CertificatesService, CertificateEventHandlers, CoursePopularity, CourseSearchHandlers, { provide: COURSE_PROGRESS_READER, useExisting: ProgressService }];
