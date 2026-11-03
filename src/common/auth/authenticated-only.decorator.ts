import { applyDecorators, SetMetadata } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { ApiErrorResponse } from "../openapi/error-response";

export const AUTHENTICATED_ONLY_KEY = "skiller:authenticated-only";

/**
 * Marks a route (or controller) as needing a signed-in user but no particular permission.
 * Every route must carry @RequirePermission, @Public or @AuthenticatedOnly; the app refuses to boot otherwise.
 */
export const AuthenticatedOnly = () =>
  applyDecorators(SetMetadata(AUTHENTICATED_ONLY_KEY, true), ApiBearerAuth(), ApiErrorResponse(401, "Missing, invalid or expired access token."));
