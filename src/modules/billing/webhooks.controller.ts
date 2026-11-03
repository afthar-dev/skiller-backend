import { Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Prisma, type WebhookProvider } from "@prisma/client";
import type { Queue } from "bullmq";
import type { Request } from "express";
import { Public } from "../../common/auth/public.decorator";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { AppError } from "../../common/errors/app-error";
import { ApiErrorResponse } from "../../common/openapi/error-response";
import { PrismaService } from "../../common/prisma/prisma.service";
import { InjectQueue, QueueNames } from "../../common/queue";
import { verifyWebhookSignature } from "./signature";
import { WEBHOOK_PROCESS_JOB, type WebhookJobData } from "./webhook.processor";

const MAX_EVENT_ID_LENGTH = 200;
const header = (req: Request, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Razorpay / RazorpayX webhook intake. Authenticity comes from the signature over the raw body, so the routes are @Public.
 * Responsibilities stop at "verified, stored once, queued": processing happens in the billing queue so the response is fast
 * and a handler failure never makes Razorpay redeliver.
 */
@Public()
@ApiTags("Webhooks")
@Controller("webhooks")
export class WebhooksController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectQueue(QueueNames.billing) private readonly queue: Queue<WebhookJobData>,
  ) {}

  @Post("razorpay")
  @HttpCode(200)
  @ApiOperation({ summary: "Razorpay webhook (HMAC-SHA256 signed)" })
  @ApiErrorResponse(400, "Invalid signature, missing event id, or malformed payload.")
  razorpay(@Req() req: RawBodyRequest<Request>) {
    return this.intake("RAZORPAY", this.config.razorpay.webhookSecret, req);
  }

  @Post("razorpayx")
  @HttpCode(200)
  @ApiOperation({ summary: "RazorpayX (payouts) webhook (HMAC-SHA256 signed)" })
  @ApiErrorResponse(400, "Invalid signature, missing event id, or malformed payload.")
  razorpayx(@Req() req: RawBodyRequest<Request>) {
    return this.intake("RAZORPAYX", this.config.razorpayx.webhookSecret, req);
  }

  private async intake(provider: WebhookProvider, secret: string, req: RawBodyRequest<Request>): Promise<{ received: true }> {
    const raw = req.rawBody;
    if (!raw) throw new Error("rawBody is not enabled; create the app with { rawBody: true }");

    // Signature first: an unauthenticated caller learns nothing else about what we accept.
    if (!verifyWebhookSignature(raw, header(req, "x-razorpay-signature"), secret)) {
      throw new AppError("WEBHOOK_SIGNATURE_INVALID", 400, "Invalid webhook signature");
    }
    const eventId = header(req, "x-razorpay-event-id")?.trim();
    if (!eventId || eventId.length > MAX_EVENT_ID_LENGTH) throw new AppError("WEBHOOK_EVENT_ID_MISSING", 400, "x-razorpay-event-id header is required");

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new AppError("WEBHOOK_PAYLOAD_INVALID", 400, "Webhook body is not valid JSON");
    }
    const type = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { event?: unknown }).event : undefined;
    if (typeof type !== "string" || type.length === 0) throw new AppError("WEBHOOK_PAYLOAD_INVALID", 400, "Webhook body has no event type");

    let row: { id: string; processedAt: Date | null };
    try {
      row = await this.prisma.webhookEvent.create({ data: { provider, eventId, type, payload: payload as Prisma.InputJsonObject }, select: { id: true, processedAt: true } });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
      row = await this.prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider, eventId } }, select: { id: true, processedAt: true } });
    }

    // jobId = row id makes enqueueing idempotent. Re-adding for an unprocessed duplicate repairs the case where the first
    // delivery stored the row but crashed before the job was added; a finished event is never queued again.
    if (!row.processedAt) await this.queue.add(WEBHOOK_PROCESS_JOB, { webhookEventId: row.id }, { jobId: row.id });
    return { received: true };
  }
}
