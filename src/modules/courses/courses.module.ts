import { Module, forwardRef } from "@nestjs/common";
import { MediaModule } from "../media";
import { UsersModule } from "../users";
import { AdminCategoriesController, CategoriesController } from "./categories.controller";
import { CategoriesService } from "./categories.service";
import { CourseMedia } from "./course-media";
import { CoursePolicy } from "./course.policy";
import { CoursesService } from "./courses.service";
import { CurriculumService } from "./curriculum.service";
import { PublicCurriculumController, StudioCurriculumController } from "./curriculum.controller";
import { StudioCoursesController } from "./studio-courses.controller";

@Module({
  // forwardRef: module classes arrive through other modules' index files, which may still be loading when this file is evaluated.
  imports: [forwardRef(() => UsersModule), forwardRef(() => MediaModule)],
  controllers: [StudioCoursesController, StudioCurriculumController, PublicCurriculumController, CategoriesController, AdminCategoriesController],
  providers: [CoursePolicy, CourseMedia, CoursesService, CurriculumService, CategoriesService],
  exports: [CoursePolicy, CoursesService, CategoriesService],
})
export class CoursesModule {}
