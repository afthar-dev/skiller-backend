import { Injectable, Logger } from "@nestjs/common";
import { NotificationsService, type NotifyInput } from "../notifications";

/** Tells creators and commenters about their reels. Best effort: a failed notification never undoes what happened. */
@Injectable()
export class ReelNotifier {
  private readonly logger = new Logger(ReelNotifier.name);

  constructor(private readonly notifications: NotificationsService) {}

  async notifyUser(userId: string, input: NotifyInput): Promise<void> {
    try {
      await this.notifications.notify(userId, input);
    } catch (err) {
      this.logger.error(`could not notify user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
