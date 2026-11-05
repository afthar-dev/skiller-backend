import { Module } from "@nestjs/common";
import { AccountService } from "../identity";
import { NotificationEventHandlers } from "./notification-events.handler";
import { NotificationFilters } from "./notification-filters";
import { NotificationsService } from "./notifications.service";

/** Worker process: the outbox handlers that create notifications and queue their emails. */
@Module({ providers: [AccountService, NotificationFilters, NotificationsService, NotificationEventHandlers], exports: [NotificationFilters, NotificationsService] })
export class NotificationsWorkerModule {}
