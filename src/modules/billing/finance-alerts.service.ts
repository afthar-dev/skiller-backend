import { Injectable, Logger } from "@nestjs/common";
import { reportException } from "../../common/observability/sentry";
import { NotificationsService } from "../notifications";
import { PlatformRoleDirectory } from "../rbac";

export type FinanceAlertKind = "PAYMENT_AMOUNT_MISMATCH" | "DUPLICATE_PAYMENT" | "COUPON_OVER_LIMIT" | "COUPON_REDEMPTION_CONFLICT" | "FULFILMENT_FAILED" | "REFUND_FAILED" | "REFUND_UNMATCHED" | "REFUND_WEBHOOK_FAILED";

export const FINANCE_ADMIN_ROLE = "finance_admin";
const PAGE = 100;

/**
 * Money anomalies a human must look at: reported to Sentry and put in every finance admin's in-app notifications. Never throws
 * (an alert failing must not undo or block the payment it is about); repeats of the same alert are collapsed by `dedupeKey`.
 */
@Injectable()
export class FinanceAlerts {
  private readonly logger = new Logger(FinanceAlerts.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly roles: PlatformRoleDirectory,
  ) {}

  async raise(alert: { kind: FinanceAlertKind; orderId?: string; message: string; dedupeKey: string; data?: Record<string, unknown> }): Promise<void> {
    this.logger.error(`finance alert ${alert.kind} for order ${alert.orderId ?? "(unknown)"}: ${alert.message}`);
    try {
      reportException(new Error(`[finance] ${alert.kind}: ${alert.message} (order ${alert.orderId ?? "unknown"})`), 500);
      let cursor: string | undefined;
      for (;;) {
        const ids = await this.roles.userIdsWithRole(FINANCE_ADMIN_ROLE, cursor, PAGE);
        for (const userId of ids) {
          await this.notifications.notify(userId, {
            type: "finance.alert",
            title: "Payment needs attention",
            body: alert.message,
            link: alert.orderId ? `/admin/orders/${alert.orderId}` : "/admin/refunds",
            data: { ...alert.data, kind: alert.kind, orderId: alert.orderId },
            sourceEventId: `finance:${alert.dedupeKey}`,
          });
        }
        if (ids.length < PAGE) break;
        cursor = ids[ids.length - 1];
      }
    } catch (err) {
      this.logger.error(`could not deliver finance alert ${alert.kind} for order ${alert.orderId ?? "(unknown)"}: ${(err as Error).message}`);
    }
  }
}
