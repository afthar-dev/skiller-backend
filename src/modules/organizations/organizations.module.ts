import { Module, OnModuleInit, forwardRef } from "@nestjs/common";
import { MediaModule } from "../media";
import { OrgParamResolverRegistry } from "../rbac";
import { UsersModule } from "../users";
import { OrganizationsController, OrgInvitesController } from "./organizations.controller";
import { OrganizationsService } from "./organizations.service";

@Module({
  // forwardRef: module classes arrive through other modules' index files, which may still be loading when this file is evaluated.
  imports: [forwardRef(() => UsersModule), forwardRef(() => MediaModule)],
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
