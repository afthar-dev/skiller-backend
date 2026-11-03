// Public surface of the rbac module. Other modules import only from here.
export { RequirePermission } from "./require-permission.decorator";
export { PermissionService } from "./permission.service";
export type { EffectivePermissions } from "./permission.service";
export { PlatformRoleDirectory } from "./platform-role-directory";
export { RolesService } from "./roles.service";
export type { MutationMeta, RoleView, UserRoleView } from "./roles.service";
export { MEMBER_ROLE_KEY, SUPER_ADMIN_ROLE_KEY } from "./default-roles";
export { OrgParamResolverRegistry } from "./org-param-resolver";
export type { OrgParamResolver } from "./org-param-resolver";
export { RbacModule } from "./rbac.module";
export { RbacWorkerModule } from "./rbac-worker.module";
