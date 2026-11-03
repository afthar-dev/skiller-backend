import { Module } from "@nestjs/common";
import { AccountService } from "../identity";
import { NotificationEventHandlers } from "./notification-events.handler";
import { NotificationsService } from "./notifications.service";

/** Worker process: the outbox handlers that create notifications and queue their emails. */
@Module({ providers: [AccountService, NotificationsService, NotificationEventHandlers], exports: [NotificationsService] })
export class NotificationsWorkerModule {}
