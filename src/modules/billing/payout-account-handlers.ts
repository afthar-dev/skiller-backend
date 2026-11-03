import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PayoutAccountsService, type ValidationResult } from "./payout-accounts.service";
import { WebhookDispatcher, type WebhookEventContext } from "./webhook.dispatcher";

const asRecord = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

const resultOf = (payload: Record<string, unknown>): ValidationResult | null => {
  const entity = asRecord(asRecord(asRecord(payload.payload)?.["fund_account.validation"])?.entity);
  const fundAccountId = text(asRecord(entity?.fund_account)?.id) ?? text(entity?.fund_account_id);
  const status = text(entity?.status);
  if (!fundAccountId || !status) return null;
  const results = asRecord(entity?.results);
  return { fundAccountId, status, accountStatus: text(results?.account_status), registeredName: text(results?.registered_name) };
};

/** Wires the RazorpayX fund-account validation webhooks to the payout accounts. Idempotent (the dispatcher is at-least-once). */
@Injectable()
export class PayoutAccountHandlers implements OnModuleInit {
  private readonly logger = new Logger(PayoutAccountHandlers.name);

  constructor(
    private readonly dispatcher: WebhookDispatcher,
    private readonly accounts: PayoutAccountsService,
  ) {}

  onModuleInit() {
    this.dispatcher.on("fund_account.validation.completed", (e) => this.handle(e));
    this.dispatcher.on("fund_account.validation.failed", (e) => this.handle(e));
  }

  private async handle(event: WebhookEventContext): Promise<void> {
    const result = resultOf(event.payload);
    if (!result) {
      this.logger.warn(`webhook ${event.webhookEventId} (${event.type}) has no fund account or status; ignored`);
      return;
    }
    await this.accounts.onValidation(result);
  }
}
