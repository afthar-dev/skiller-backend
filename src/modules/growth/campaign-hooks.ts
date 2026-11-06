import { Injectable, OnModuleInit } from "@nestjs/common";
import { MailHooks } from "../mail";
import { CampaignSender } from "./campaign-sender";

/** Wires the mail module's webhook notices to the sender: delivery events fill the campaign stats. (What became of each mail is PromoMailProcessor's own bookkeeping.) */
@Injectable()
export class CampaignMailHooks implements OnModuleInit {
  constructor(
    private readonly hooks: MailHooks,
    private readonly sender: CampaignSender,
  ) {}

  onModuleInit() {
    this.hooks.onEvent((event) => this.sender.onResendEvent(event.type, event.emailId));
  }
}
