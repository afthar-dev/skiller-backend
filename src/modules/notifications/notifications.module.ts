import { Global, Module } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller";
import { NotificationFilters } from "./notification-filters";
import { NotificationsService } from "./notifications.service";
import { PromoPreferences } from "./promo-preferences";

/** API side: the REST endpoints. Global so other modules can call `notify()` directly. The outbox handlers live in NotificationsWorkerModule. */
@Global()
@Module({ controllers: [NotificationsController], providers: [NotificationFilters, NotificationsService, PromoPreferences], exports: [NotificationFilters, NotificationsService, PromoPreferences] })
export class NotificationsModule {}
