import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma, type CreditNote } from "@prisma/client";
import { v7 as uuidv7 } from "uuid";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ObjectStorage } from "../media";
import { allocateNumber, creditNoteKey } from "./document-support";
import { InvoiceIssuer } from "./invoice-issuer";
import { documentLines, renderInvoicePdf, type DocumentFacts, type InvoiceDetails } from "./invoice-document";
import { toApi } from "./money";

const negate = (paise: string) => toApi(-BigInt(paise));
const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * GST credit notes (CGST s.34): when a refund is processed the invoice is corrected by a credit note in its own gap-free series
 * (SKC/yy-yy/nnnnnn, one counter per financial year), referencing the invoice and mirroring it with negative amounts (full refunds
 * only). Same two steps as invoices: number + row in one transaction, then the PDF upload, which a retry or the sweeper completes.
 */
@Injectable()
export class CreditNoteIssuer {
  private readonly logger = new Logger(CreditNoteIssuer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoiceIssuer,
    private readonly storage: ObjectStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Idempotent per refund. The invoice is issued first if its own event has not been handled yet. */
  async issueForRefund(refundId: string): Promise<{ creditNoteId: string; number: string } | null> {
    const existing = await this.prisma.creditNote.findUnique({ where: { refundId } });
    if (existing) return this.finish(existing);

    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund || refund.status !== "PROCESSED") return null;
    const issued = await this.invoices.issueForOrder(refund.orderId);
    if (!issued) return null;
    const invoice = await this.prisma.invoice.findUniqueOrThrow({ where: { id: issued.invoiceId } });
    const original = invoice.details as unknown as InvoiceDetails;
    const issuedAt = this.clock.now(); // the refund is processed; the credit note is dated when it is issued

    const created = await this.create(refund.id, {
      at: issuedAt,
      invoiceId: invoice.id,
      orderId: refund.orderId,
      buyerUserId: invoice.buyerUserId,
      sellerOwnerType: invoice.sellerOwnerType,
      sellerOwnerId: invoice.sellerOwnerId,
      totalPaise: -invoice.totalPaise,
      taxPaise: -invoice.taxPaise,
      facts: {
        kind: original.kind,
        // the identity and registration of the invoice being corrected
        platform: original.platform,
        buyer: original.buyer,
        sellerName: original.sellerName,
        itemTitle: original.itemTitle,
        listPaise: negate(original.listPaise),
        discountPaise: negate(original.discountPaise),
        totalPaise: negate(original.totalPaise),
        gst: { ...original.gst, basePaise: negate(original.gst.basePaise), taxPaise: negate(original.gst.taxPaise), feeTotalPaise: negate(original.gst.feeTotalPaise) },
        original: { number: invoice.number, issuedAt: invoice.issuedAt.toISOString() },
      },
    });
    return this.finish(created);
  }

  async ensureUploaded(note: CreditNote): Promise<void> {
    if (note.uploadedAt) return;
    const pdf = await renderInvoicePdf(note.details as unknown as InvoiceDetails);
    await this.storage.putPrivate(note.objectKey, pdf, "application/pdf");
    await this.prisma.creditNote.updateMany({ where: { id: note.id, uploadedAt: null }, data: { uploadedAt: this.clock.now() } });
  }

  async completePending(olderThanMs: number, limit = 100): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - olderThanMs);
    const pending = await this.prisma.creditNote.findMany({ where: { uploadedAt: null, createdAt: { lt: cutoff } }, orderBy: { id: "asc" }, take: limit });
    let done = 0;
    for (const note of pending) {
      try {
        await this.ensureUploaded(note);
        done += 1;
      } catch (err) {
        this.logger.warn(`could not upload credit note ${note.number}: ${(err as Error).message}`);
      }
    }
    return done;
  }

  private async finish(note: CreditNote): Promise<{ creditNoteId: string; number: string }> {
    await this.ensureUploaded(note);
    return { creditNoteId: note.id, number: note.number };
  }

  private async create(
    refundId: string,
    n: {
      at: Date;
      invoiceId: string;
      orderId: string;
      buyerUserId: string | null;
      sellerOwnerType: "USER" | "ORG" | null;
      sellerOwnerId: string | null;
      totalPaise: bigint;
      taxPaise: bigint;
      facts: Omit<DocumentFacts, "number" | "issuedAt" | "docType">;
    },
  ): Promise<CreditNote> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const number = await allocateNumber(tx, "SKC", n.at);
        const id = uuidv7();
        const facts: DocumentFacts = { ...n.facts, docType: "CREDIT_NOTE", number, issuedAt: n.at.toISOString() };
        const details: InvoiceDetails = { ...facts, lines: documentLines(facts) };
        return tx.creditNote.create({
          data: {
            id,
            number,
            refundId,
            invoiceId: n.invoiceId,
            orderId: n.orderId,
            buyerUserId: n.buyerUserId,
            sellerOwnerType: n.sellerOwnerType,
            sellerOwnerId: n.sellerOwnerId,
            objectKey: creditNoteKey(id),
            totalPaise: n.totalPaise,
            taxPaise: n.taxPaise,
            details: details as unknown as Prisma.InputJsonValue,
            issuedAt: n.at,
          },
        });
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const winner = await this.prisma.creditNote.findUnique({ where: { refundId } });
      if (!winner) throw err;
      return winner;
    }
  }
}
