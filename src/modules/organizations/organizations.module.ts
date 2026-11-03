import { Module, OnModuleInit } from "@nestjs/common";
import { MediaModule } from "../media/media.module";
import { OrgParamResolverRegistry } from "../rbac/org-param-resolver";
import { UsersModule } from "../users/users.module";
import { OrganizationsController, OrgInvitesController } from "./organizations.controller";
import { OrganizationsService } from "./organizations.service";

@Module({
  imports: [UsersModule, MediaModule],
  controllers: [OrganizationsController, OrgInvitesController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule implements OnModuleInit {
  constructor(
    private readonly registry: OrgParamResolverRegistry,
    private readonly orgs: OrganizationsService,
  ) {}

  onModuleInit() {
    // @RequirePermission(key, { orgParam: "slug" }) routes address the org by slug; RBAC asks us for the id.
    this.registry.register("slug", (slug) => this.orgs.idForSlug(slug));
  }
}
