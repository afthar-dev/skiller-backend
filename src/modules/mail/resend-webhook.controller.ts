import { Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { Webhook } from "svix";
import { Public } from "../../common/auth/public.decorator";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiErrorResponse } from "../../common/openapi/error-response";
import { MailHooks } from "./mail-hooks";

interface ResendEvent {
  type: string;
  data?: { to?: string[] | string; email_id?: string };
}

const SUPPRESSING: Record<string, "bounced" | "complained"> = {
  "email.bounced": "bounced",
  "email.complained": "complained",
};

@Public()
@ApiTags("Webhooks")
@Controller("webhooks")
export class ResendWebhookController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly hooks: MailHooks,
  ) {}

  @Post("resend")
  @HttpCode(200)
  @ApiOperation({ summary: "Resend delivery webhook (Svix-signed)" })
  @ApiErrorResponse(401, "Invalid signature.")
  async handle(@Req() req: RawBodyRequest<Request>) {
    const raw = req.rawBody;
    if (!raw) throw new Error("rawBody is not enabled; create the app with { rawBody: true }");

    let event: ResendEvent;
    try {
      event = new Webhook(this.config.resend.webhookSecret).verify(raw.toString("utf8"), {
        "svix-id": String(req.headers["svix-id"] ?? ""),
        "svix-timestamp": String(req.headers["svix-timestamp"] ?? ""),
        "svix-signature": String(req.headers["svix-signature"] ?? ""),
      }) as ResendEvent;
    } catch {
      throw new AppError("INVALID_SIGNATURE", 401, "Invalid webhook signature");
    }

    const reason = SUPPRESSING[event.type];
    if (reason) {
      const recipients = ([] as string[]).concat(event.data?.to ?? []).map((e) => e.trim().toLowerCase());
      for (const email of recipients) {
        // A hard bounce must never be downgraded to a complaint (complaints still allow transactional mail).
        await this.prisma.emailSuppression.upsert({
          where: { email },
          create: { email, reason },
          update: reason === "bounced" ? { reason } : {},
        });
      }
    }
    // Delivery events (delivered, opened, clicked) name the mail by Resend's id; whoever queued it may keep stats. Idempotent on their side.
    if (event.data?.email_id) await this.hooks.emitEvent({ type: event.type, emailId: event.data.email_id });
    return { received: true };
  }
}
