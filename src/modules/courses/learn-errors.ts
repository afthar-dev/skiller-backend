import type { Course } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import { courseNotFound } from "./course.policy";

export const notEnrolled = () => new AppError("COURSE_NOT_ENROLLED", 403, "Enrol in this course to open its lessons");

/** Whoever may not learn a course is told it exists only when it is public; otherwise it does not exist for them. */
export const denied = (course: Pick<Course, "status" | "flaggedAt">) => (course.status === "PUBLISHED" && !course.flaggedAt ? notEnrolled() : courseNotFound());
