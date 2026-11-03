import { Global, Module } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { FlagsService } from "./flags.service";
import { SettingsService } from "./settings.service";

/**
 * Settings and flags without the admin HTTP surface, so the worker process can read them too (e.g. the transcode duration cap).
 * AuditService is provided here because the worker does not load AuditModule (it only needs Prisma).
 */
@Global()
@Module({ providers: [AuditService, SettingsService, FlagsService], exports: [SettingsService, FlagsService] })
export class SettingsModule {}
