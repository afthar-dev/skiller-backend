import { Injectable, OnModuleInit } from "@nestjs/common";
import { EventBus } from "../../common/outbox/event-bus";
import { NotificationsService } from "./notifications.service";

const FAILURE_REASONS: Record<string, string> = {
  DURATION_EXCEEDED: "The video is longer than the 90 seconds allowed for reels.",
  NO_VIDEO_STREAM: "The file does not contain a video track.",
  INVALID_MEDIA: "The file is damaged or in a format we cannot read.",
  INVALID_IMAGE: "The image is damaged or in a format we cannot read.",
  UPLOAD_SIZE_MISMATCH: "The upload was incomplete.",
};
const DEFAULT_FAILURE_REASON = "Something went wrong while processing the file.";
const VIDEO_PURPOSES = new Set(["reel", "course_lesson"]);

/**
 * Worker-side outbox handlers. The outbox is at-least-once, so every notify() carries the event id (meta.eventId):
 * the row and the mail are both deduplicated on it. `org.member_invited` is handled by organizations (email only).
 */
@Injectable()
export class NotificationEventHandlers implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.bus.on("user.registered", async (e, { eventId }) => {
      await this.notifications.notify(e.userId, {
        type: "welcome",
        title: "Welcome to Skiller",
        body: "Your account is ready. Complete your profile to get started.",
        link: "/me",
        email: { template: "welcome", data: { name: e.email.split("@")[0] || "there" }, to: e.email },
        sourceEventId: eventId,
      });
    });

    this.bus.on("media.ready", async (e, { eventId }) => {
      await this.notifications.notify(e.ownerId, {
        type: "media.ready",
        title: VIDEO_PURPOSES.has(e.purpose) ? "Your video is ready" : "Your upload is ready",
        body: "Processing has finished and your file is ready to use.",
        data: { assetId: e.assetId, purpose: e.purpose },
        sourceEventId: eventId,
      });
    });

    this.bus.on("media.failed", async (e, { eventId }) => {
      const reason = FAILURE_REASONS[e.reason] ?? DEFAULT_FAILURE_REASON;
      await this.notifications.notify(e.ownerId, {
        type: "media.failed",
        title: "Your upload could not be processed",
        body: reason,
        data: { assetId: e.assetId, reason: e.reason },
        email: { template: "media_failed", data: { fileName: e.fileName ?? "your file", reason } },
        sourceEventId: eventId,
      });
    });

    this.bus.on("role.granted", async (e, { eventId }) => {
      await this.notifications.notify(e.userId, {
        type: "role.granted",
        title: "You were given a new role",
        body: `You now have the ${e.roleKey} role.`,
        data: { roleKey: e.roleKey },
        sourceEventId: eventId,
      });
    });
  }
}
