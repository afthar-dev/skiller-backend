import { applyDecorators, createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import { ApiExtension } from "@nestjs/swagger";
import { ApiErrorResponse } from "../openapi/error-response";
import type { AuthUser } from "./auth-user";

export const OPTIONAL_AUTH_KEY = "skiller:optional-auth";
/** Marker the OpenAPI builder turns into `security: [{bearer: []}, {}]` (a token is accepted, none is fine) and removes. */
export const OPTIONAL_AUTH_EXTENSION = "x-optional-auth";

/**
 * A route that works signed out and signed in. A request with no Authorization header runs anonymously (`@OptionalUser()` is null);
 * one that sends a token is authenticated exactly as on an @AuthenticatedOnly route, so a bad, expired or revoked token is still 401
 * and the client can refresh, instead of being quietly downgraded to a visitor. The handler decides what an anonymous caller may see.
 */
export const OptionalAuth = () =>
  applyDecorators(SetMetadata(OPTIONAL_AUTH_KEY, true), ApiExtension(OPTIONAL_AUTH_EXTENSION, true), ApiErrorResponse(401, "A token was sent but it is invalid, expired or revoked (no token at all is fine)."));

/** The signed-in user on an @OptionalAuth route, or null for a signed-out caller. */
export const OptionalUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser | null => {
  return (ctx.switchToHttp().getRequest().user as AuthUser | undefined) ?? null;
});
