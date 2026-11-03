import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Coupon, Order, OrderItem } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { CouponsService } from "./coupons.service";
import { toApi } from "./money";

/** A CREATED order that was never paid is closed after this long. */
export const ORDER_EXPIRY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_BATCH = 500;

type OrderRow = Order & { items: OrderItem[]; coupon: Pick<Coupon, "code"> | null; invoice: { id: string } | null; refunds: { creditNote: { id: string } | null }[] };

export interface OrderView {
  id: string;
  status: Order["status"];
  currency: string;
  listPricePaise: string;
  discountPaise: string;
  totalPaise: string;
  couponCode: string | null;
  razorpayOrderId: string | null;
  items: { itemType: string; itemId: string; title: string; unitPricePaise: string }[];
  createdAt: string;
  paidAt: string | null;
  /** The tax invoice, once issued (GET /v1/invoices/:id/download). */
  invoiceId: string | null;
  /** The GST credit note, once the order is refunded. */
  creditNoteId: string | null;
}

const include = { items: true, coupon: { select: { code: true } }, invoice: { select: { id: true } }, refunds: { where: { creditNote: { isNot: null } }, select: { creditNote: { select: { id: true } } }, take: 1 } } as const;

export const toOrderView = (o: OrderRow): OrderView => ({
  id: o.id,
  status: o.status,
  currency: o.currency,
  listPricePaise: toApi(o.listPricePaise),
  discountPaise: toApi(o.discountPaise),
  totalPaise: toApi(o.totalPaise),
  couponCode: o.coupon?.code ?? null,
  razorpayOrderId: o.razorpayOrderId,
  items: o.items.map((i) => ({ itemType: i.itemType, itemId: i.itemId, title: i.title, unitPricePaise: toApi(i.unitPricePaise) })),
  createdAt: o.createdAt.toISOString(),
  paidAt: o.paidAt?.toISOString() ?? null,
  invoiceId: o.invoice?.id ?? null,
  creditNoteId: o.refunds[0]?.creditNote?.id ?? null,
});

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly coupons: CouponsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async listFor(buyerId: string, page: PageQuery) {
    const rows = await this.prisma.order.findMany({
      where: { buyerId, ...(page.cursor ? { id: { lt: page.cursor } } : {}) },
      orderBy: { id: "desc" }, // UUIDv7: id order is time order
      take: page.limit + 1,
      include,
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    return { items: items.map(toOrderView), nextCursor };
  }

  /** Another buyer's (or an unknown) order is a 404, never a hint that it exists. */
  async getFor(buyerId: string, id: string): Promise<OrderView> {
    const row = await this.prisma.order.findFirst({ where: { id, buyerId }, include });
    if (!row) throw new AppError("ORDER_NOT_FOUND", 404, "Order not found");
    return toOrderView(row);
  }

  /** payment.failed: the attempt failed, but the buyer may retry on the same Razorpay order, so a later capture still fulfils it. */
  async markFailedByRazorpayOrder(razorpayOrderId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const open = await tx.order.findMany({ where: { razorpayOrderId, status: "CREATED" }, select: { id: true } });
      const res = await tx.order.updateMany({ where: { id: { in: open.map((o) => o.id) }, status: "CREATED" }, data: { status: "FAILED" } });
      await this.coupons.release(tx, open.map((o) => o.id));
      return res.count === 1;
    });
  }

  /** CREATED orders older than 24 h become EXPIRED. Each pass is a conditional bulk update, so overlapping runs are harmless. */
  async expireStale(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - ORDER_EXPIRY_MS);
    let total = 0;
    for (;;) {
      const ids = await this.prisma.order.findMany({ where: { status: "CREATED", createdAt: { lt: cutoff } }, select: { id: true }, orderBy: { id: "asc" }, take: EXPIRY_BATCH });
      if (ids.length === 0) break;
      const res = await this.prisma.$transaction(async (tx) => {
        const flipped = await tx.order.updateMany({ where: { id: { in: ids.map((r) => r.id) }, status: "CREATED" }, data: { status: "EXPIRED" } });
        // A paid order reservation is already REDEEMED (flipped in its fulfilment transaction), so only expired orders give a use back.
        await this.coupons.release(tx, ids.map((r) => r.id));
        return flipped;
      });
      total += res.count;
      if (ids.length < EXPIRY_BATCH || res.count === 0) break;
    }
    if (total > 0) this.logger.log(`expired ${total} unpaid order(s)`);
    return total;
  }
}
