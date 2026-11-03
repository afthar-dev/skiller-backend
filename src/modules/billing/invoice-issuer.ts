import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma, type Invoice, type Order } from "@prisma/client";
import { v7 as uuidv7 } from "uuid";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";
import { SettingsService } from "../admin";
import { AccountService } from "../identity";
import { ObjectStorage } from "../media";
import { ProfilesService } from "../users";
import { financialYear, invoiceNumber } from "./fiscal-year";
import { invoiceLines, renderInvoicePdf, type InvoiceDetails, type InvoiceFacts } from "./invoice-document";
import { toApi } from "./money";
import { splitSale } from "./sale-split";
import { SUBSCRIPTION_CHARGE_REF } from "./subscriptions.service";

export interface IssuedInvoice {
  invoiceId: string;
  number: string;
}

export const invoiceKey = (invoiceId: string) => `invoices/${invoiceId}.pdf`;
const SUBSCRIPTION_CHARGE_DESCRIPTION = "Subscription charge";

/** A new row plus the numbering facts the transaction needs; everything the PDF prints is decided before the transaction. */
interface NewInvoice {
  at: Date;
  orderId?: string;
  paymentId?: string;
  subscriptionId?: string;
  buyerUserId: string | null;
  sellerOwnerType?: "USER" | "ORG";
  sellerOwnerId?: string;
  totalPaise: bigint;
  taxPaise: bigint;
  facts: Omit<InvoiceFacts, "number" | "issuedAt">;
}

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * Issues tax invoices. Two steps, both safe to repeat:
 *  1. one transaction takes the next number of the financial year (counter row locked FOR UPDATE, so numbers are sequential and a
 *     rolled-back attempt leaves no gap) and creates the row with the frozen print details;
 *  2. the PDF is rendered from those details and put in the private bucket; uploadedAt marks that it is there.
 * A failure after step 1 leaves a numbered invoice without a file; the next call (outbox retry, or the sweeper job) finishes it.
 */
@Injectable()
export class InvoiceIssuer {
  private readonly logger = new Logger(InvoiceIssuer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorage,
    private readonly settings: SettingsService,
    private readonly profiles: ProfilesService,
    private readonly accounts: AccountService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async issueForOrder(orderId: string): Promise<IssuedInvoice | null> {
    const existing = await this.prisma.invoice.findUnique({ where: { orderId } });
    if (existing) return this.finish(existing);

    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order?.paidAt || !order.razorpayPaymentId) return null; // not paid (yet): nothing to invoice
    const item = order.items[0];
    if (!item) return null;

    const split = splitSale({ listPaise: order.listPricePaise, discountPaise: order.discountPaise, fundedBy: order.couponFundedBy, commissionBps: order.commissionBps, gstBps: order.gstBps });
    const feeTotal = split.feeNetPaise + split.feeTaxPaise;
    const buyer = await this.partyOfUser(order.buyerId);
    const created = await this.create({
      at: order.paidAt,
      orderId,
      buyerUserId: order.buyerId,
      sellerOwnerType: order.sellerOwnerType,
      sellerOwnerId: order.sellerOwnerId,
      totalPaise: order.totalPaise,
      taxPaise: split.feeTaxPaise,
      facts: {
        kind: "ORDER",
        platformGstin: await this.settings.get("platform_gstin"),
        buyer,
        sellerName: await this.sellerName(order),
        itemTitle: item.title,
        listPaise: toApi(order.listPricePaise),
        discountPaise: toApi(order.discountPaise),
        totalPaise: toApi(order.totalPaise),
        gst: { bps: order.gstBps, basePaise: toApi(split.feeNetPaise), taxPaise: toApi(split.feeTaxPaise), feeTotalPaise: toApi(feeTotal), baseLabel: "Platform fee excluding GST" },
      },
    });
    return this.finish(created);
  }

  /** One invoice per successful subscription payment. The amounts are the ones booked in the charge's ledger entry. */
  async issueForSubscriptionCharge(input: { subscriptionId: string; paymentId: string; notifyUserId?: string }): Promise<IssuedInvoice | null> {
    const existing = await this.prisma.invoice.findUnique({ where: { paymentId: input.paymentId } });
    if (existing) return this.finish(existing);

    const entry = await this.prisma.journalEntry.findUnique({
      where: { refType_refId_description: { refType: SUBSCRIPTION_CHARGE_REF, refId: input.paymentId, description: SUBSCRIPTION_CHARGE_DESCRIPTION } },
      include: { lines: { include: { account: { select: { kind: true } } } } },
    });
    const sub = await this.prisma.subscription.findUnique({ where: { id: input.subscriptionId }, include: { planVersion: { include: { plan: { select: { name: true } } } } } });
    if (!entry || !sub) return null;
    const sum = (kind: string) => entry.lines.filter((l) => l.account.kind === kind).reduce((s, l) => s + l.amountPaise, 0n);
    const total = -sum("GATEWAY_CLEARING");
    const tax = sum("TAX_PAYABLE");
    const net = sum("PLATFORM_REVENUE");
    // The rate the charge was booked at, recovered from its own lines (GST rates are whole percents).
    const gstBps = net > 0n ? Math.round(Number((tax * 10_000n) / net) / 100) * 100 : 0;

    const buyerUserId = input.notifyUserId ?? (sub.ownerType === "USER" ? sub.ownerId : null);
    const buyer = buyerUserId ? await this.partyOfUser(buyerUserId) : { name: "Customer", email: "" };
    const interval = sub.planVersion.interval === "YEAR" ? "yearly" : "monthly";
    const created = await this.create({
      at: this.clock.now(),
      paymentId: input.paymentId,
      subscriptionId: sub.id,
      buyerUserId,
      totalPaise: total,
      taxPaise: tax,
      facts: {
        kind: "SUBSCRIPTION",
        platformGstin: await this.settings.get("platform_gstin"),
        buyer: sub.ownerType === "ORG" ? { name: await this.orgName(sub.ownerId), email: buyer.email } : buyer,
        sellerName: "Skiller",
        itemTitle: `${sub.planVersion.plan.name} plan (${interval})`,
        listPaise: toApi(total),
        discountPaise: "0",
        totalPaise: toApi(total),
        gst: { bps: gstBps, basePaise: toApi(net), taxPaise: toApi(tax), feeTotalPaise: toApi(total), baseLabel: "Subscription fee excluding GST" },
      },
    });
    return this.finish(created);
  }

  /** Renders and uploads the PDF of an invoice that has none yet. */
  async ensureUploaded(invoice: Invoice): Promise<void> {
    if (invoice.uploadedAt) return;
    const pdf = await renderInvoicePdf(invoice.details as unknown as InvoiceDetails);
    await this.storage.putPrivate(invoice.objectKey, pdf, "application/pdf");
    await this.prisma.invoice.updateMany({ where: { id: invoice.id, uploadedAt: null }, data: { uploadedAt: this.clock.now() } });
  }

  /** Invoices stuck without a file (storage was down when they were issued). Returns how many were completed. */
  async completePending(olderThanMs: number, limit = 100): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - olderThanMs);
    const pending = await this.prisma.invoice.findMany({ where: { uploadedAt: null, createdAt: { lt: cutoff } }, orderBy: { id: "asc" }, take: limit });
    let done = 0;
    for (const invoice of pending) {
      try {
        await this.ensureUploaded(invoice);
        done += 1;
      } catch (err) {
        this.logger.warn(`could not upload invoice ${invoice.number}: ${(err as Error).message}`);
      }
    }
    return done;
  }

  private async finish(invoice: Invoice): Promise<IssuedInvoice> {
    await this.ensureUploaded(invoice);
    return { invoiceId: invoice.id, number: invoice.number };
  }

  /** Step 1. A concurrent duplicate loses on the unique key, rolls back (its number is not consumed) and returns the winner's row. */
  private async create(n: NewInvoice): Promise<Invoice> {
    const fy = financialYear(n.at);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO invoice_counters ("fy", "lastNumber") VALUES (${fy}, 0) ON CONFLICT ("fy") DO NOTHING`;
        const rows = await tx.$queryRaw<{ lastNumber: number }[]>`UPDATE invoice_counters SET "lastNumber" = "lastNumber" + 1 WHERE "fy" = ${fy} RETURNING "lastNumber"`;
        const number = invoiceNumber(fy, rows[0].lastNumber);
        const id = uuidv7();
        const facts: InvoiceFacts = { ...n.facts, number, issuedAt: n.at.toISOString() };
        const details: InvoiceDetails = { ...facts, lines: invoiceLines(facts) };
        return tx.invoice.create({
          data: {
            id,
            number,
            objectKey: invoiceKey(id),
            ...(n.orderId ? { orderId: n.orderId } : {}),
            ...(n.paymentId ? { paymentId: n.paymentId } : {}),
            ...(n.subscriptionId ? { subscriptionId: n.subscriptionId } : {}),
            buyerUserId: n.buyerUserId,
            sellerOwnerType: n.sellerOwnerType ?? null,
            sellerOwnerId: n.sellerOwnerId ?? null,
            totalPaise: n.totalPaise,
            taxPaise: n.taxPaise,
            details: details as unknown as Prisma.InputJsonValue,
            issuedAt: n.at,
          },
        });
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const winner = await this.prisma.invoice.findFirst({ where: n.orderId ? { orderId: n.orderId } : { paymentId: n.paymentId } });
      if (!winner) throw err;
      return winner;
    }
  }

  private async partyOfUser(userId: string): Promise<{ name: string; email: string }> {
    const [name, email] = await Promise.all([this.profiles.displayNameOf(userId), this.accounts.findEmail(userId)]);
    return { name, email: email ?? "" };
  }

  private async sellerName(order: Order): Promise<string> {
    return order.sellerOwnerType === "USER" ? this.profiles.displayNameOf(order.sellerOwnerId) : this.orgName(order.sellerOwnerId);
  }

  /** Organization names are read straight from the row: billing's worker process has no organizations service to ask. */
  private async orgName(orgId: string): Promise<string> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    return org?.name ?? "Organization";
  }
}

