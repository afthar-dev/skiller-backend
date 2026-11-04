import { Module, forwardRef } from "@nestjs/common";
import { EntitlementsModule } from "../billing";
import { MediaModule } from "../media";
import { UsersModule } from "../users";
import { AdminCategoriesController, CategoriesController } from "./categories.controller";
import { CategoriesService } from "./categories.service";
import { AdminCoursesController } from "./admin-courses.controller";
import { CourseMedia } from "./course-media";
import { CourseNotifier } from "./course-notifier";
import { CoursePolicy } from "./course.policy";
import { CoursesService } from "./courses.service";
import { ModerationService } from "./moderation.service";
import { PublishingService } from "./publishing.service";
import { CurriculumService } from "./curriculum.service";
import { PublicCurriculumController, StudioCurriculumController } from "./curriculum.controller";
import { StudioCoursesController } from "./studio-courses.controller";

@Module({
  // forwardRef: module classes arrive through other modules' index files, which may still be loading when this file is evaluated.
  imports: [forwardRef(() => UsersModule), forwardRef(() => MediaModule), EntitlementsModule],
  controllers: [StudioCoursesController, StudioCurriculumController, PublicCurriculumController, CategoriesController, AdminCategoriesController, AdminCoursesController],
  providers: [CoursePolicy, CourseMedia, CourseNotifier, CoursesService, CurriculumService, CategoriesService, PublishingService, ModerationService],
  exports: [CoursePolicy, CoursesService, CategoriesService],
})
export class CoursesModule {}
