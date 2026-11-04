import { Module } from "@nestjs/common";
import { AccountsService } from "./accounts.service";
import { LedgerIntegrity } from "./ledger-integrity.service";
import { LedgerService } from "./ledger.service";
import { WalletEventHandlers } from "./wallet-events.handler";

/** What the worker process needs from wallet: the outbox handlers that create seller accounts. */
@Module({ providers: [LedgerService, LedgerIntegrity, AccountsService, WalletEventHandlers], exports: [LedgerService, LedgerIntegrity, AccountsService] })
export class WalletWorkerModule {}
