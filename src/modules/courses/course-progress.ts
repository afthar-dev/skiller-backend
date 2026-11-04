import { Injectable } from "@nestjs/common";

export const COURSE_PROGRESS_READER = Symbol("COURSE_PROGRESS_READER");

/**
 * How much of a course a learner has completed. Refund eligibility asks it; whoever tracks lesson progress answers it.
 * Returns the percentage (0..100) of the course's required lessons the learner has completed.
 */
export interface CourseProgressReader {
  completedRequiredPct(userId: string, courseId: string): Promise<number>;
}

/**
 * The reader bound until lesson progress is tracked: nobody has completed anything yet. The progress feature replaces this
 * binding (same token) with one that reads its own tables.
 */
@Injectable()
export class NoCourseProgress implements CourseProgressReader {
  async completedRequiredPct(): Promise<number> {
    return 0;
  }
}
