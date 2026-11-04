import { Module } from "@nestjs/common";

/** What the worker process needs from courses: outbox handlers and processors are added here as the later tasks land. */
@Module({})
export class CoursesWorkerModule {}
