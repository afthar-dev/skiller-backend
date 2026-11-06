import { Injectable, OnModuleInit } from "@nestjs/common";
import { MailHooks } from "../mail";
import { CampaignSender } from "./campaign-sender";

/** Wires the mail module's outcome and webhook notices to the sender: Resend ids land on recipients, delivery events fill the stats. */
@Injectable()
export class CampaignMailHooks implements OnModuleInit {
  constructor(
    private readonly hooks: MailHooks,
    private readonly sender: CampaignSender,
  ) {}

  onModuleInit() {
    this.hooks.onOutcome("campaign", async (ref, outcome) => {
      const [campaignId, userId] = ref.key.split(":");
      if (campaignId && userId) await this.sender.onMailOutcome(campaignId, userId, outcome);
    });
    this.hooks.onEvent((event) => this.sender.onResendEvent(event.type, event.emailId));
  }
}
