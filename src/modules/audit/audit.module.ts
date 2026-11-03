import { Global, Module } from "@nestjs/common";
import { AuditController } from "./audit.controller";
import { OutboxDeadController } from "./outbox-dead.controller";
import { AuditService } from "./audit.service";

@Global()
@Module({ controllers: [AuditController, OutboxDeadController], providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
