import { Module } from "@nestjs/common";
import { OrganizationDirectory } from "./organization-directory";

/** The organization directory on its own: usable from the worker process and from any module without pulling in the organizations API. */
@Module({ providers: [OrganizationDirectory], exports: [OrganizationDirectory] })
export class OrganizationsWorkerModule {}
