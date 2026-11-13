import { applyDecorators } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";

type Schema = Record<string, unknown>;

const str = { type: "string" } as const;
const isoDate = { type: "string", format: "date-time" } as const;
const nullableStr = { type: "string", nullable: true } as const;

export const profileViewSchema: Schema = {
  type: "object",
  required: [
    "userId",
    "handle",
    "displayName",
    "headline",
    "about",
    "avatarAssetId",
    "bannerAssetId",
    "avatarUrl",
    "bannerUrl",
    "location",
    "links",
    "followersCount",
    "followingCount",
    "isCreator",
    "verifiedAt",
    "updatedAt",
  ],
  properties: {
    userId: str,
    handle: str,
    displayName: str,
    headline: nullableStr,
    about: nullableStr,
    avatarAssetId: nullableStr,
    bannerAssetId: nullableStr,
    avatarUrl: { ...nullableStr, description: "Public URL of the READY avatar; null when there is none or it is not ready." },
    bannerUrl: { ...nullableStr, description: "Public URL of the READY banner; null when there is none or it is not ready." },
    location: nullableStr,
    links: { type: "array", items: { type: "object", properties: { label: str, url: str } } },
    followersCount: { type: "integer" },
    followingCount: { type: "integer" },
    isCreator: { type: "boolean" },
    verifiedAt: { ...isoDate, nullable: true },
    updatedAt: isoDate,
  },
};

/** The owner's view of their own profile (/me, PATCH /me/profile): the public view plus private settings. */
export const ownProfileViewSchema: Schema = {
  ...profileViewSchema,
  properties: {
    ...(profileViewSchema.properties as Schema),
    allowMessagesFrom: { type: "string", enum: ["EVERYONE", "FOLLOWING", "NONE"], description: "Who may start a conversation with you. Private: never shown on the public profile." },
  },
};

export const mediaAssetSchema: Schema = {
  type: "object",
  properties: {
    id: str,
    status: { type: "string", enum: ["PENDING", "UPLOADED", "PROCESSING", "READY", "FAILED"] },
    urls: { type: "object", nullable: true, additionalProperties: str, description: "Public URLs once READY (public purposes only)." },
  },
  additionalProperties: true,
};

/** Documents a successful JSON response with an inline schema. */
export const ApiJsonResponse = (status: number, description: string, schema: Schema) => applyDecorators(ApiResponse({ status, description, schema: schema as never }));

export const objectSchema = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({ type: "object", required, properties });
export const schemas = { str, isoDate, nullableStr };

/** Documents a `text/event-stream` success response; `eventSchema` names the component that describes the data of the `message` event. */
export const ApiEventStream = (description: string, eventSchema: string) =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description,
      content: { "text/event-stream": { schema: { type: "string", description: "Event stream. The data of a message event is a #/components/schemas/" + eventSchema + "." } } },
    } as never),
  );

/** Documents a 204 response (no body). */
export const ApiNoContent = (description: string) => applyDecorators(ApiResponse({ status: 204, description }));

const integer = { type: "integer" } as const;
const bool = { type: "boolean" } as const;

/** Compact member card used in follower, following, block and mute lists. */
export const profileSummarySchema: Schema = objectSchema(
  { id: str, handle: str, displayName: str, headline: nullableStr, avatarAssetId: nullableStr, avatarUrl: nullableStr },
  ["id", "handle", "displayName", "avatarUrl"],
);

/** A cursor page: `nextCursor` is null on the last page. */
export const pageSchema = (item: Schema): Schema => objectSchema({ items: { type: "array", items: item }, nextCursor: nullableStr }, ["items", "nextCursor"]);

/** The member's own lists (experience, education, skills, portfolio) as returned by PUT /me/*. */
export const listOf = (item: Schema): Schema => objectSchema({ items: { type: "array", items: item } });

export const experienceItemSchema: Schema = objectSchema(
  { id: str, title: str, company: str, startDate: str, endDate: nullableStr, description: nullableStr },
  ["id", "title", "company", "startDate", "endDate", "description"],
);
export const educationItemSchema: Schema = objectSchema(
  { id: str, school: str, degree: nullableStr, field: nullableStr, startYear: { ...integer, nullable: true }, endYear: { ...integer, nullable: true } },
  ["id", "school", "degree", "field", "startYear", "endYear"],
);
export const portfolioItemSchema: Schema = objectSchema(
  { id: str, title: str, url: nullableStr, mediaAssetId: nullableStr, description: nullableStr },
  ["id", "title", "url", "mediaAssetId", "description"],
);

/** The public profile: the profile view plus its lists; `isFollowing` appears only for a signed-in viewer. */
export const publicProfileSchema: Schema = {
  ...profileViewSchema,
  required: [...(profileViewSchema.required as string[]), "experience", "education", "skills", "portfolio"],
  properties: {
    ...(profileViewSchema.properties as Schema),
    experience: { type: "array", items: experienceItemSchema },
    education: { type: "array", items: educationItemSchema },
    skills: { type: "array", items: str },
    portfolio: { type: "array", items: portfolioItemSchema },
    isFollowing: { ...bool, description: "Present only when the request carries a valid access token." },
  },
};

/** One row of GET /me/blocks and /me/mutes. */
export const relationItemSchema: Schema = objectSchema({ id: str, handle: str, displayName: str, avatarUrl: nullableStr, since: isoDate });

/** Documents a `text/csv` success response (a file download): the body is CSV text, not JSON. */
export const ApiCsv = (description: string, example?: string) =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description,
      headers: { "Content-Disposition": { description: "attachment; filename=...", schema: { type: "string" } } },
      content: { "text/csv": { schema: { type: "string", ...(example ? { example } : {}) } } },
    } as never),
  );
