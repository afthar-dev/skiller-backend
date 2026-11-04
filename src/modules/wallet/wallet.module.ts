import { Module } from "@nestjs/common";
import { AccountsService } from "./accounts.service";
import { LedgerIntegrity } from "./ledger-integrity.service";
import { LedgerService } from "./ledger.service";

@Module({
  providers: [LedgerService, LedgerIntegrity, AccountsService],
  exports: [LedgerService, LedgerIntegrity, AccountsService],
})
export class WalletModule {}
