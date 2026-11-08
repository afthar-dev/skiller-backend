import { objectSchema, pageSchema, schemas } from "../../common/openapi/responses";

// Response schemas of the course catalog, learning and certificate routes. Each one is the shape a handler really returns
// (the view builders next to the services); the e2e specs check live responses against them.
type Schema = Record<string, unknown>;

const { str, isoDate, nullableStr } = schemas;
const int: Schema = { type: "integer" };
const bool: Schema = { type: "boolean" };
const nullableDate: Schema = { ...isoDate, nullable: true };
const money: Schema = { $ref: "#/components/schemas/Money" };
const strings: Schema = { type: "array", items: str };
const enumOf = (...values: string[]): Schema => ({ type: "string", enum: values });

const thumbnailUrl: Schema = { ...nullableStr, description: "Public URL of the 1024 px wide rendition of the thumbnail (16:9 card size); null when there is no thumbnail or it is not ready." };
const ownerType = enumOf("USER", "ORG");
const level = enumOf("BEGINNER", "INTERMEDIATE", "ADVANCED", "ALL");
const lessonType = enumOf("VIDEO", "ARTICLE", "QUIZ", "RESOURCE");
const courseStatus = enumOf("DRAFT", "IN_REVIEW", "PUBLISHED", "ARCHIVED");
const ratingAvg: Schema = { type: "number", nullable: true, description: "Null until 3 learners rated." };

const catalogCardProperties: Record<string, Schema> = {
  id: str,
  ownerType,
  ownerId: str,
  ownerName: str,
  slug: str,
  title: str,
  subtitle: nullableStr,
  categoryId: str,
  level,
  language: str,
  tags: strings,
  pricePaise: money,
  thumbnailAssetId: nullableStr,
  thumbnailUrl,
  promoVideoAssetId: nullableStr,
  publishedAt: nullableDate,
  ratingAvg,
  ratingCount: int,
  enrolmentCount: int,
};

/** A course in a catalog listing: the public page without the long description. */
export const catalogCardSchema: Schema = objectSchema(catalogCardProperties);

/** What anyone may see of a published course. */
export const publicCourseSchema: Schema = objectSchema({ ...catalogCardProperties, description: str });

export const catalogPageSchema: Schema = pageSchema(catalogCardSchema);

export const categoryListSchema: Schema = objectSchema({
  items: { type: "array", items: objectSchema({ id: str, slug: str, name: str, position: int, isActive: bool }) },
});

/** The curriculum anyone sees: titles, durations, free-preview flags; a free-preview video lesson also carries its asset id. */
export const publicCurriculumSchema: Schema = objectSchema({
  course: objectSchema({ id: str, slug: str, title: str }),
  sections: {
    type: "array",
    items: objectSchema({
      id: str,
      title: str,
      position: int,
      durationSec: int,
      lessons: {
        type: "array",
        items: objectSchema(
          { id: str, title: str, type: lessonType, position: int, durationSec: { ...int, nullable: true }, isFreePreview: bool, videoAssetId: str },
          ["id", "title", "type", "position", "durationSec", "isFreePreview"],
        ),
      },
    }),
  },
  totals: objectSchema({ sections: int, lessons: int, durationSec: int }),
});

const reviewAuthor = objectSchema({ handle: nullableStr, displayName: str, avatarAssetId: nullableStr });

export const reviewListSchema: Schema = objectSchema({
  items: {
    type: "array",
    items: objectSchema({ id: str, rating: int, body: nullableStr, createdAt: isoDate, updatedAt: isoDate, reply: nullableStr, repliedAt: nullableDate, author: reviewAuthor }),
  },
  nextCursor: nullableStr,
  summary: objectSchema({ ratingAvg, ratingCount: int }),
});

export const myReviewSchema: Schema = objectSchema({
  id: str,
  courseId: str,
  rating: int,
  body: nullableStr,
  createdAt: isoDate,
  updatedAt: isoDate,
  reply: nullableStr,
  repliedAt: nullableDate,
  hidden: { ...bool, description: "True while a moderator or the end of the enrolment keeps the review off the course page." },
});

/** A learner's enrolment with its course's name and the progress. */
export const enrolmentSchema: Schema = objectSchema({
  id: str,
  courseId: str,
  courseSlug: str,
  courseTitle: str,
  thumbnailAssetId: nullableStr,
  thumbnailUrl,
  courseStatus,
  flagged: { ...bool, description: "A moderator hid the course from the catalog; enrolled learners keep their access." },
  source: enumOf("PURCHASE", "FREE", "ORG_SEAT"),
  progressPct: int,
  completedAt: nullableDate,
  enrolledAt: isoDate,
});

export const learningPageSchema: Schema = pageSchema(enrolmentSchema);

const access = enumOf("ENROLLED", "AUTHOR", "PREVIEW", "REVIEW");

/** The player's curriculum with the learner's progress. */
export const learnCourseSchema: Schema = objectSchema({
  course: objectSchema({ id: str, slug: str, title: str, status: courseStatus, progressPct: int, completedAt: nullableDate, thumbnailUrl }),
  access,
  sections: {
    type: "array",
    items: objectSchema({
      id: str,
      title: str,
      position: int,
      lessons: {
        type: "array",
        items: objectSchema({
          id: str,
          title: str,
          type: lessonType,
          position: int,
          durationSec: { ...int, nullable: true },
          isFreePreview: bool,
          isRequired: bool,
          completed: bool,
          positionSec: int,
        }),
      },
    }),
  },
});

/** One lesson's content. Only the field of its own type is filled; the others are null. */
export const lessonContentSchema: Schema = objectSchema({
  id: str,
  courseId: str,
  courseSlug: str,
  sectionId: str,
  title: str,
  type: lessonType,
  position: int,
  durationSec: { ...int, nullable: true },
  isFreePreview: bool,
  isRequired: bool,
  articleBody: nullableStr,
  videoAssetId: nullableStr,
  quizId: nullableStr,
  resource: { ...objectSchema({ url: str, filename: nullableStr, expiresAt: isoDate }), nullable: true, description: "A 5-minute download link, for RESOURCE lessons." },
  access,
  canTrackProgress: bool,
  progress: objectSchema({ positionSec: int, completed: bool }),
});

export const progressResultSchema: Schema = objectSchema({
  positionSec: int,
  watchedSec: int,
  completed: bool,
  courseProgressPct: int,
});

const quizOption = objectSchema({ id: str, text: str });

export const quizViewSchema: Schema = objectSchema({
  id: str,
  lessonId: str,
  courseSlug: str,
  passPct: int,
  passed: bool,
  nextAttemptAt: nullableStr,
  questions: {
    type: "array",
    items: objectSchema(
      { id: str, prompt: str, kind: enumOf("SINGLE", "MULTIPLE"), options: { type: "array", items: quizOption }, correct: { ...strings, description: "Option ids of the right answers; present only once the learner has a passing attempt." } },
      ["id", "prompt", "kind", "options"],
    ),
  },
});

export const quizAttemptSchema: Schema = objectSchema(
  {
    attemptId: str,
    scorePct: int,
    passed: bool,
    passPct: int,
    nextAttemptAt: str,
    correct: { type: "object", additionalProperties: strings, description: "Right option ids per question id; present only when the attempt passed." },
  },
  ["attemptId", "scorePct", "passed", "passPct", "nextAttemptAt"],
);

export const certificateSchema: Schema = objectSchema({
  id: str,
  code: str,
  courseId: str,
  courseSlug: str,
  courseTitle: str,
  learnerName: { ...nullableStr, description: "Null while the certificate waits for its name (PENDING_NAME)." },
  issuer: str,
  issuedAt: isoDate,
  status: enumOf("VALID", "REVOKED", "PENDING_NAME"),
});

export const certificatePageSchema: Schema = pageSchema(certificateSchema);

/** What anyone holding the code sees: no user id, e-mail, certificate id or course id. */
export const publicCertificateSchema: Schema = objectSchema({
  code: str,
  learnerName: str,
  courseTitle: str,
  issuer: str,
  issuedAt: isoDate,
  status: enumOf("VALID", "REVOKED"),
});

export const certificateDownloadSchema: Schema = objectSchema({ url: str, expiresAt: isoDate });

const author = objectSchema({ handle: nullableStr, displayName: str, avatarAssetId: nullableStr });

export const questionViewSchema: Schema = objectSchema({ id: str, lessonId: str, body: str, createdAt: isoDate, answerCount: int, author });
export const questionPageSchema: Schema = pageSchema(questionViewSchema);
export const answerViewSchema: Schema = objectSchema({ id: str, questionId: str, body: str, isInstructor: bool, createdAt: isoDate, author });
export const answerPageSchema: Schema = pageSchema(answerViewSchema);
