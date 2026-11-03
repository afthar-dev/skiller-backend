import { applyDecorators } from "@nestjs/common";
import { ApiBody, ApiQuery } from "@nestjs/swagger";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const { $schema: _ignored, ...rest } = zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" }) as JsonSchema;
  return rest;
}

/** Documents a JSON request body from the zod schema the handler validates with, so docs cannot drift from validation. */
export const ApiZodBody = (schema: z.ZodTypeAny, opts: { required?: boolean } = {}) =>
  applyDecorators(ApiBody({ required: opts.required ?? true, schema: toJsonSchema(schema) as never }));

/** Documents each property of a zod object as a query parameter. */
export const ApiZodQuery = (schema: z.ZodObject<z.ZodRawShape>) => {
  const json = toJsonSchema(schema) as { properties?: Record<string, JsonSchema>; required?: string[] };
  return applyDecorators(
    ...Object.entries(json.properties ?? {}).map(([name, prop]) =>
      ApiQuery({ name, required: json.required?.includes(name) ?? false, schema: prop as never }),
    ),
  );
};

/** `cursor` / `limit` query parameters of the shared cursor pagination (see parsePage). */
export const ApiPagination = () =>
  applyDecorators(
    ApiQuery({ name: "cursor", required: false, type: String, description: "`nextCursor` from the previous page." }),
    ApiQuery({ name: "limit", required: false, type: Number, description: "Page size, 1-100 (default 20)." }),
  );
