import { Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { Webhook } from "svix";
import { Public } from "../../common/auth/public.decorator";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";

interface ResendEvent {
  type: string;
  data?: { to?: string[] | string };
}

const SUPPRESSING: Record<string, "bounced" | "complained"> = {
  "email.bounced": "bounced",
  "email.complained": "complained",
};

@Public()
@Controller("webhooks")
export class ResendWebhookController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post("resend")
  @HttpCode(200)
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
    return { received: true };
  }
}
