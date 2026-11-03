import { applyDecorators } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";

type Schema = Record<string, unknown>;

const str = { type: "string" } as const;
const isoDate = { type: "string", format: "date-time" } as const;
const nullableStr = { type: "string", nullable: true } as const;

export const profileViewSchema: Schema = {
  type: "object",
  required: ["userId", "handle", "displayName", "isCreator", "updatedAt"],
  properties: {
    userId: str,
    handle: str,
    displayName: str,
    headline: nullableStr,
    about: nullableStr,
    avatarAssetId: nullableStr,
    bannerAssetId: nullableStr,
    location: nullableStr,
    links: { type: "array", items: { type: "object", properties: { label: str, url: str } } },
    followersCount: { type: "integer" },
    followingCount: { type: "integer" },
    isCreator: { type: "boolean" },
    verifiedAt: { ...isoDate, nullable: true },
    updatedAt: isoDate,
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
