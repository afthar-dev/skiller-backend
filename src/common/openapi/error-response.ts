import { applyDecorators } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";

export const ERROR_RESPONSE_REF = "#/components/schemas/ErrorResponse";

/** Shared error envelope: `{ error: { code, message, details }, requestId }` (see ErrorFilter). */
export const errorResponseSchema = {
  type: "object",
  required: ["error", "requestId"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "details"],
      properties: {
        code: { type: "string", example: "VALIDATION_FAILED", description: "Stable machine-readable error code." },
        message: { type: "string" },
        details: { type: "object", additionalProperties: true, description: "Code-specific data, e.g. `fields` for validation errors or `retryAfterSec` for rate limits." },
      },
    },
    requestId: { type: "string", nullable: true, description: "Also returned in the `x-request-id` response header." },
  },
} as const;

const errorContent = { "application/json": { schema: { $ref: ERROR_RESPONSE_REF } } };

/** Documents an error status with the shared ErrorResponse schema. */
export const ApiErrorResponse = (status: number, description: string) =>
  applyDecorators(ApiResponse({ status, description, schema: { $ref: ERROR_RESPONSE_REF } }));

export const errorResponseObject = (description: string) => ({ description, content: errorContent });
