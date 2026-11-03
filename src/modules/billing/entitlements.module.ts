import { Module } from "@nestjs/common";
import { EntitlementsService } from "./entitlements.service";
import { UsageRegistry } from "./usage.registry";

/**
 * EntitlementsService and the usage registry, with no dependency on other feature modules. Media and organizations import this (not BillingModule),
 * so enforcing a plan limit never creates a module cycle with the users module that billing needs for creator checks.
 */
@Module({ providers: [EntitlementsService, UsageRegistry], exports: [EntitlementsService, UsageRegistry] })
export class EntitlementsModule {}
