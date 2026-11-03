import { SetMetadata } from "@nestjs/common";

export const REQUIRE_PERMISSION_KEY = "skiller:require-permission";

export interface RequirePermissionMeta {
  key: string;
  /** Name of the route param holding the org id; the permission is then checked for that org (platform grants still pass). */
  orgParam?: string;
}

export const RequirePermission = (key: string, opts: { orgParam?: string } = {}) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, { key, orgParam: opts.orgParam } satisfies RequirePermissionMeta);
