import { SetMetadata } from "@nestjs/common";

export const AUTHENTICATED_ONLY_KEY = "skiller:authenticated-only";

/**
 * Marks a route (or controller) as needing a signed-in user but no particular permission.
 * Every route must carry @RequirePermission, @Public or @AuthenticatedOnly; the app refuses to boot otherwise.
 */
export const AuthenticatedOnly = () => SetMetadata(AUTHENTICATED_ONLY_KEY, true);
