import type { Provider } from "@nestjs/common";
import { COURSE_PROGRESS_READER, NoCourseProgress } from "./course-progress";
import { CourseRefundEligibility } from "./course-refund-eligibility";
import { CourseSellable } from "./course.sellable";
import { EnrolmentsService } from "./enrolments.service";
import { OrgMemberRemovedHandler } from "./org-member-removed.handler";

/** What both the API and the worker process run for courses: the COURSE sellable and its refund rule, enrolments and the organization event handler. */
export const COURSES_CORE_PROVIDERS: Provider[] = [EnrolmentsService, CourseSellable, CourseRefundEligibility, OrgMemberRemovedHandler, { provide: COURSE_PROGRESS_READER, useClass: NoCourseProgress }];
