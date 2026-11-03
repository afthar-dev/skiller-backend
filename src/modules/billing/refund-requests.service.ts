import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type RefundStatus } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit";
import { NotificationsService } from "../notifications";
import type { MutationMeta } from "../rbac";
import { RefundEligibilityRegistry } from "./refund-eligibility";
import { LIVE_REFUND, RefundsService, toRefundView, type RefundView } from "./refunds.service";
import type { PaidOrder } from "./sellable.registry";

const notEligible = (reason: string) => new AppError("REFUND_NOT_ELIGIBLE", 422, reason, { reason });
const notPending = () => new AppError("REFUND_NOT_PENDING", 409, "This refund has already been decided");
const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/** The HTTP side of refunds: the buyer's request and finance's decision (audited). Everything after the decision lives in RefundsService. */
@Injectable()
export class RefundRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: RefundEligibilityRegistry,
    private readonly refunds: RefundsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The buyer asks for a full refund. Another buyer's (or an unknown) order is a 404; an order that cannot be refunded is REFUND_NOT_ELIGIBLE. */
  async request(buyerId: string, orderId: string, reason: string): Promise<RefundView> {
    const owned = await this.prisma.order.findFirst({ where: { id: orderId, buyerId }, select: { id: true } });
    if (!owned) throw new AppError("ORDER_NOT_FOUND", 404, "Order not found");
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialises requests, approvals and the payment for this order; the partial unique index is the backstop.
        await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
        const order: PaidOrder = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
        if (order.status !== "PAID") throw notEligible(order.status === "REFUNDED" ? "This order has already been refunded" : "Only paid orders can be refunded");
        if (await tx.refund.findFirst({ where: { orderId, status: { in: LIVE_REFUND } }, select: { id: true } })) {
          throw notEligible("A refund has already been requested or issued for this order");
        }
        const rule = this.eligibility.forType(order.items[0]?.itemType ?? "");
        const verdict = await rule.check({ order, now: this.clock.now() });
        if (!verdict.eligible) throw notEligible(verdict.reason);
        const refund = await tx.refund.create({ data: { orderId, amountPaise: order.totalPaise, status: "REQUESTED", reason, requestedBy: buyerId } });
        return toRefundView(refund);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw notEligible("A refund has already been requested or issued for this order");
      throw err;
    }
  }

  async list(filter: { status?: RefundStatus }, page: PageQuery) {
    const rows = await this.prisma.refund.findMany({
      where: { ...(filter.status ? { status: filter.status } : {}), ...(page.cursor ? { id: { lt: page.cursor } } : {}) },
      orderBy: { id: "desc" },
      take: page.limit + 1,
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    return { items: items.map(toRefundView), nextCursor };
  }

  /**
   * Finance approves: the decision is stored and audited in one transaction, then the Razorpay refund is started outside it.
   * Approving an APPROVED refund again retries the start (after an outage); a refund already underway is returned as it is.
   */
  async approve(actorId: string, refundId: string, meta: MutationMeta = {}): Promise<RefundView> {
    const state = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "refunds" WHERE "id" = ${refundId} FOR UPDATE`;
      const refund = await tx.refund.findUnique({ where: { id: refundId } });
      if (!refund) throw new AppError("REFUND_NOT_FOUND", 404, "Refund not found");
      if (refund.status === "REQUESTED") {
        const approved = await tx.refund.update({ where: { id: refund.id }, data: { status: "APPROVED", decidedBy: actorId } });
        await this.audit.record(tx, { actorId, action: "refund.approve", targetType: "refund", targetId: refund.id, before: toRefundView(refund), after: toRefundView(approved), ...meta });
        return "start" as const;
      }
      if (refund.status === "APPROVED") return "start" as const;
      if (refund.status === "PROCESSING" || refund.status === "PROCESSED") return "done" as const;
      throw notPending();
    });
    const refund = state === "start" ? await this.refunds.start(refundId) : await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    return toRefundView(refund);
  }

  async reject(actorId: string, refundId: string, note: string | undefined, meta: MutationMeta = {}): Promise<RefundView> {
    const rejected = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "refunds" WHERE "id" = ${refundId} FOR UPDATE`;
      const refund = await tx.refund.findUnique({ where: { id: refundId } });
      if (!refund) throw new AppError("REFUND_NOT_FOUND", 404, "Refund not found");
      if (refund.status !== "REQUESTED") throw notPending();
      const updated = await tx.refund.update({ where: { id: refund.id }, data: { status: "REJECTED", decidedBy: actorId, ...(note ? { failureReason: note.slice(0, 500) } : {}) } });
      await this.audit.record(tx, { actorId, action: "refund.reject", targetType: "refund", targetId: refund.id, before: toRefundView(refund), after: { ...toRefundView(updated), note: note ?? null }, ...meta });
      return updated;
    });
    await this.notifications.notify(rejected.requestedBy, {
      type: "refund.rejected",
      title: "Refund request declined",
      body: note ? `Your refund request was declined: ${note}` : "Your refund request was declined.",
      link: `/orders/${rejected.orderId}`,
      data: { orderId: rejected.orderId, refundId: rejected.id },
      sourceEventId: `refund-rejected:${rejected.id}`,
    });
    return toRefundView(rejected);
  }
}
