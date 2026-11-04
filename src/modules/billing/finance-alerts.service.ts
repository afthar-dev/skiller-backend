import { Injectable, Logger } from "@nestjs/common";
import { reportException } from "../../common/observability/sentry";
import { NotificationsService, type NotifyInput } from "../notifications";
import { PlatformRoleDirectory } from "../rbac";

export type FinanceAlertKind = "PAYMENT_AMOUNT_MISMATCH" | "DUPLICATE_PAYMENT" | "COUPON_OVER_LIMIT" | "COUPON_REDEMPTION_CONFLICT" | "FULFILMENT_FAILED" | "REFUND_FAILED" | "REFUND_UNMATCHED" | "REFUND_WEBHOOK_FAILED"
  | "DUPLICATE_PAN"
  | "PAYOUT_FAILED"
  | "PAYOUT_UNMATCHED"
  | "PAYOUT_AMOUNT_MISMATCH"
  | "PAYOUT_WEBHOOK_FAILED"
  | "RECONCILIATION_MISMATCH"
  | "RECONCILIATION_ERROR";

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

  /** An ordinary notification to every finance admin (no Sentry report), e.g. "a payout awaits approval". Idempotent per `sourceKey`. Never throws. */
  async broadcast(n: { type: NotifyInput["type"]; title: string; body: string; link: string; data?: Record<string, unknown>; sourceKey: string }): Promise<void> {
    try {
      let cursor: string | undefined;
      for (;;) {
        const ids = await this.roles.userIdsWithRole(FINANCE_ADMIN_ROLE, cursor, PAGE);
        for (const userId of ids) {
          await this.notifications.notify(userId, { type: n.type, title: n.title, body: n.body, link: n.link, data: n.data, sourceEventId: `finance:${n.sourceKey}` });
        }
        if (ids.length < PAGE) break;
        cursor = ids[ids.length - 1];
      }
    } catch (err) {
      this.logger.error(`could not notify finance (${n.type}): ${(err as Error).message}`);
    }
  }

  async raise(alert: { kind: FinanceAlertKind; orderId?: string; message: string; dedupeKey: string; data?: Record<string, unknown>; link?: string }): Promise<void> {
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
            link: alert.link ?? (alert.orderId ? `/admin/orders/${alert.orderId}` : "/admin/refunds"),
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
