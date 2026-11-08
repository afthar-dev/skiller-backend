import { Module, forwardRef } from "@nestjs/common";
import { BillingModule, EntitlementsModule } from "../billing";
import { MediaModule, ObjectStorageModule } from "../media";
import { ModerationModule } from "../moderation";
import { OrganizationsWorkerModule } from "../organizations";
import { UsersModule } from "../users";
import { AdminCategoriesController, CategoriesController } from "./categories.controller";
import { CategoriesService } from "./categories.service";
import { AdminCoursesController } from "./admin-courses.controller";
import { StudioAnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";
import { CatalogController } from "./catalog.controller";
import { CatalogCursor } from "./catalog-cursor";
import { CatalogService } from "./catalog.service";
import { CertificatesController } from "./certificates.controller";
import { CourseCategories } from "./course-categories";
import { CourseLookup } from "./course-lookup";
import { CourseMedia } from "./course-media";
import { CoursePlaybackPolicy } from "./course-playback.policy";
import { CourseNotifier } from "./course-notifier";
import { CourseThumbnails } from "./course-thumbnails";
import { COURSES_CORE_PROVIDERS } from "./courses-core";
import { EnrolmentsService } from "./enrolments.service";
import { CoursePolicy } from "./course.policy";
import { CoursesService } from "./courses.service";
import { LearnController } from "./learn.controller";
import { LearnService } from "./learn.service";
import { LearningController } from "./learning.controller";
import { ModerationService } from "./moderation.service";
import { PublishingService } from "./publishing.service";
import { CurriculumService } from "./curriculum.service";
import { PublicCurriculumController, StudioCurriculumController } from "./curriculum.controller";
import { QuizAttemptsService } from "./quiz-attempts.service";
import { LearnQuizzesController, StudioQuizzesController } from "./quizzes.controller";
import { QuizzesService } from "./quizzes.service";
import { ContentModerationService } from "./content-moderation.service";
import { CourseModerationTargets } from "./course-moderation-targets";
import { QaController } from "./qa.controller";
import { QaService } from "./qa.service";
import { AdminContentController, ReviewsController, StudioReviewsController } from "./reviews.controller";
import { ReviewsService } from "./reviews.service";
import { SelfEnrolmentService } from "./self-enrolment.service";
import { StudioCoursesController } from "./studio-courses.controller";

@Module({
  // forwardRef: module classes arrive through other modules' index files, which may still be loading when this file is evaluated.
  imports: [forwardRef(() => UsersModule), forwardRef(() => MediaModule), forwardRef(() => BillingModule), EntitlementsModule, ObjectStorageModule, forwardRef(() => OrganizationsWorkerModule), forwardRef(() => ModerationModule)],
  controllers: [CatalogController, StudioAnalyticsController, StudioCoursesController, StudioCurriculumController, PublicCurriculumController, CategoriesController, AdminCategoriesController, AdminCoursesController, LearningController, LearnController, StudioQuizzesController, LearnQuizzesController, CertificatesController, ReviewsController, StudioReviewsController, AdminContentController, QaController],
  providers: [AnalyticsService, CatalogCursor, CatalogService, CoursePolicy, CourseLookup, CourseMedia, CourseNotifier, CourseThumbnails, CoursesService, CurriculumService, CategoriesService, PublishingService, ModerationService, SelfEnrolmentService, LearnService, QuizzesService, QuizAttemptsService, ReviewsService, QaService, ContentModerationService, CourseModerationTargets, CoursePlaybackPolicy, ...COURSES_CORE_PROVIDERS],
  exports: [CoursePolicy, CourseLookup, CourseCategories, CoursesService, CategoriesService, EnrolmentsService],
})
export class CoursesModule {}
