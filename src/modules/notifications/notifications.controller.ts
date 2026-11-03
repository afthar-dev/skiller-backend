import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { parsePage } from "../../common/http/pagination";
import { NOTIFICATION_TYPE_KEYS } from "./notification-types";
import { NotificationsService } from "./notifications.service";

const preferencesBody = z
  .object({
    items: z
      .array(
        z
          .object({ type: z.enum(NOTIFICATION_TYPE_KEYS), inApp: z.boolean().optional(), email: z.boolean().optional() })
          .strict()
          .refine((v) => v.inApp !== undefined || v.email !== undefined, "inApp or email is required"),
      )
      .min(1)
      .max(50),
  })
  .strict();

@Controller()
@AuthenticatedOnly()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get("notifications")
  list(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.notifications.list(user.id, parsePage(query), query.unread === "true");
  }

  @Get("notifications/unread-count")
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user.id);
  }

  @Post("notifications/read-all")
  @HttpCode(200)
  readAll(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.id);
  }

  @Post("notifications/:id/read")
  @HttpCode(200)
  read(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.notifications.markRead(user.id, id);
  }

  @Get("me/notification-preferences")
  preferences(@CurrentUser() user: AuthUser) {
    return this.notifications.listPreferences(user.id);
  }

  @Put("me/notification-preferences")
  updatePreferences(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.notifications.updatePreferences(user.id, preferencesBody.parse(body).items);
  }
}
