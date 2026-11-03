import { Global, Module } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";

/** API side: the REST endpoints. Global so other modules can call `notify()` directly. The outbox handlers live in NotificationsWorkerModule. */
@Global()
@Module({ controllers: [NotificationsController], providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
