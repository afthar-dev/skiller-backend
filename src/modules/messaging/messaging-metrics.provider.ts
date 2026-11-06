import { Injectable } from "@nestjs/common";
import { istDayRange } from "../../common/clock/ist";
import type { MetricPoint, MetricsProvider } from "../../common/metrics/metrics-provider";
import { PrismaService } from "../../common/prisma/prisma.service";

/**
 * Daily rollup numbers owned by messaging: messages sent, and gig inquiries = conversations that began that day from a gig. A buyer who writes
 * again to someone they already talk to (a conversation is one per pair) is not a new inquiry.
 */
@Injectable()
export class MessagingMetricsProvider implements MetricsProvider {
  readonly module = "messaging";

  constructor(private readonly prisma: PrismaService) {}

  async collect(day: string): Promise<MetricPoint[]> {
    const { from, to } = istDayRange(day);
    const [inquiries, messages] = await Promise.all([
      this.prisma.conversation.count({ where: { gigId: { not: null }, createdAt: { gte: from, lt: to } } }),
      this.prisma.message.count({ where: { createdAt: { gte: from, lt: to } } }),
    ]);
    return [
      { key: "gig_inquiries", value: BigInt(inquiries) },
      { key: "messages_sent", value: BigInt(messages) },
    ];
  }
}
