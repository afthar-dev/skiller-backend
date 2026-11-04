import { applyDecorators, SetMetadata } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { ApiErrorResponse } from "../../common/openapi/error-response";

export const REQUIRE_PERMISSION_KEY = "skiller:require-permission";

export interface RequirePermissionMeta {
  key: string;
  /** Name of the route param holding the org id; the permission is then checked for that org (platform grants still pass). */
  orgParam?: string;
  /** With `orgParam`: only a grant held in that org counts; platform-wide grants (super_admin) are ignored. For routes that move an organization's money. */
  orgScopedOnly?: boolean;
}

export const RequirePermission = (key: string, opts: { orgParam?: string; orgScopedOnly?: boolean } = {}) => {
  if (opts.orgScopedOnly && !opts.orgParam) throw new Error("orgScopedOnly needs orgParam");
  return applyDecorators(
    SetMetadata(REQUIRE_PERMISSION_KEY, { key, orgParam: opts.orgParam, orgScopedOnly: opts.orgScopedOnly } satisfies RequirePermissionMeta),
    ApiBearerAuth(),
    ApiErrorResponse(401, "Missing, invalid or expired access token."),
    ApiErrorResponse(403, `Requires permission \`${key}\`.`),
  );
};
