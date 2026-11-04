import { Injectable, OnModuleInit } from "@nestjs/common";
import { EventBus } from "../../common/outbox/event-bus";
import { NotificationsService } from "../notifications";
import { CertificatesService } from "./certificates.service";

/** Certificates follow the course: issued when the learner finishes it, revoked when a refund takes it away. Both handlers are idempotent (at-least-once delivery). */
@Injectable()
export class CertificateEventHandlers implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly certificates: CertificatesService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.bus.on("course.completed", async (e, { eventId }) => {
      const cert = await this.certificates.issue(e.userId, e.courseId);
      if (!cert) return;
      // Keyed by the event id: a redelivery neither adds a second in-app row nor sends a second mail.
      await this.notifications.notify(e.userId, {
        type: "certificate.issued",
        title: "Your certificate is ready",
        body: `You completed ${cert.courseTitle}. Download your certificate or share its verification link.`,
        link: "/me/certificates",
        data: { code: cert.code, courseId: cert.courseId },
        sourceEventId: eventId,
      });
    });

    this.bus.on("order.refunded", async (e) => {
      if (e.itemType !== "COURSE") return;
      await this.certificates.revokeIfEnrolmentEnded(e.buyerId, e.itemId);
    });
  }
}
