import { Global, Module } from "@nestjs/common";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { MailProcessor } from "./mail.processor";
import { MailService } from "./mail.service";
import { ResendWebhookController } from "./resend-webhook.controller";
import { HttpResendClient, RESEND_CLIENT } from "./resend.client";

@Global()
@Module({
  controllers: [ResendWebhookController],
  providers: [
    {
      provide: RESEND_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new HttpResendClient(config.resend.apiKey, config.resend.fromAddress),
    },
    MailService,
    MailProcessor,
  ],
  exports: [MailService],
})
export class MailModule {}
