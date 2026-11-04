// Public surface of the courses module. Other modules import only from here.
export { CoursePolicy, ORG_AUTHOR_ROLES } from "./course.policy";
export { seedCategories, STARTER_CATEGORIES } from "./categories.service";
export { CourseAccessRules } from "./course-access-rules";
export type { AccessCourse, BuyerRelation, LearnAccess } from "./course-access-rules";
export { CourseMaintenanceProcessor } from "./course-maintenance.processor";
export { EnrolmentsService } from "./enrolments.service";
export type { EnrolmentView } from "./enrolments.service";
export { COURSE_PROGRESS_READER } from "./course-progress";
export type { CourseProgressReader } from "./course-progress";
export { CoursesModule } from "./courses.module";
export { assertSafeMarkdown, createMarkdownRenderer, isSafeLinkDestination } from "./markdown";
export { sanitizePlainText, sanitizeSingleLine } from "./plain-text";
export { CourseLookup } from "./course-lookup";
export type { CourseCard } from "./course-lookup";
