import { Module } from "@nestjs/common";
import { AccountService } from "../identity";
import { NotificationEventHandlers } from "./notification-events.handler";
import { NotificationFilters } from "./notification-filters";
import { NotificationsService } from "./notifications.service";
import { PromoPreferences } from "./promo-preferences";

/** Worker process: the outbox handlers that create notifications and queue their emails. */
@Module({ providers: [AccountService, NotificationFilters, NotificationsService, NotificationEventHandlers, PromoPreferences], exports: [NotificationFilters, NotificationsService, PromoPreferences] })
export class NotificationsWorkerModule {}
