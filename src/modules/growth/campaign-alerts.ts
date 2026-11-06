import { Injectable, Logger } from "@nestjs/common";
import { reportException } from "../../common/observability/sentry";
import { PrismaService } from "../../common/prisma/prisma.service";
import { NotificationsService } from "../notifications";
import { PlatformRoleDirectory, SUPER_ADMIN_ROLE_KEY } from "../rbac";

/** More than this share of the mails a campaign tried that did not go out raises an alert. */
export const FAILURE_ALERT_RATIO = 0.05;
/** Before the campaign finishes, the ratio means something only after this many mails were tried. */
export const MIN_TRIED_BEFORE_FINISH = 20;
const PAGE = 100;

/**
 * Tells the admins who run campaigns (every super admin: `campaign.manage` is theirs) when too many mails of one campaign failed or were lost.
 * Reported to Sentry too. Never throws (an alert must not undo the bookkeeping it follows) and repeats collapse per campaign and admin.
 */
@Injectable()
export class CampaignAlerts {
  private readonly logger = new Logger(CampaignAlerts.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly roles: PlatformRoleDirectory,
  ) {}

  /** `final`: the campaign is done, so even a small campaign is judged. FAILED and UNKNOWN (maybe lost) both count against it. */
  async checkFailureRate(campaignId: string, final: boolean): Promise<void> {
    try {
      const groups = await this.prisma.campaignRecipient.groupBy({ by: ["status"], where: { campaignId, status: { in: ["SENT", "FAILED", "UNKNOWN"] } }, _count: { _all: true } });
      const n = (status: string) => groups.find((g) => g.status === status)?._count._all ?? 0;
      const failed = n("FAILED") + n("UNKNOWN");
      const tried = n("SENT") + failed;
      if (tried === 0 || (!final && tried < MIN_TRIED_BEFORE_FINISH) || failed / tried <= FAILURE_ALERT_RATIO) return;
      const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { name: true } });
      const message = `"${campaign?.name ?? campaignId}": ${failed} of ${tried} promotional mails did not go out (${Math.round((failed / tried) * 100)}%)`;
      this.logger.error(`campaign alert: ${message}`);
      reportException(new Error(`[campaign] ${message}`), 500);
      let cursor: string | undefined;
      for (;;) {
        const ids = await this.roles.userIdsWithRole(SUPER_ADMIN_ROLE_KEY, cursor, PAGE);
        for (const userId of ids) {
          await this.notifications.notify(userId, {
            type: "campaign.alert",
            title: "A campaign is failing to send",
            body: message,
            link: `/admin/campaigns/${campaignId}`,
            data: { campaignId, failed, tried },
            sourceEventId: `campaign-alert:${campaignId}`,
          });
        }
        if (ids.length < PAGE) break;
        cursor = ids[ids.length - 1];
      }
    } catch (err) {
      this.logger.error(`could not deliver the failure alert of campaign ${campaignId}: ${(err as Error).message}`);
    }
  }
}
