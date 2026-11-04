import { Module, forwardRef } from "@nestjs/common";
import { MediaModule } from "../media";
import { UsersModule } from "../users";
import { AdminCategoriesController, CategoriesController } from "./categories.controller";
import { CategoriesService } from "./categories.service";
import { CourseMedia } from "./course-media";
import { CoursePolicy } from "./course.policy";
import { CoursesService } from "./courses.service";
import { StudioCoursesController } from "./studio-courses.controller";

@Module({
  // forwardRef: module classes arrive through other modules' index files, which may still be loading when this file is evaluated.
  imports: [forwardRef(() => UsersModule), forwardRef(() => MediaModule)],
  controllers: [StudioCoursesController, CategoriesController, AdminCategoriesController],
  providers: [CoursePolicy, CourseMedia, CoursesService, CategoriesService],
  exports: [CoursePolicy, CoursesService, CategoriesService],
})
export class CoursesModule {}
