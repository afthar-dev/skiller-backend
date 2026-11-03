import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ObjectStorage } from "../media";
import { PermissionService } from "../rbac";

export const INVOICE_URL_TTL_SEC = 5 * 60;

export interface DownloadLink {
  url: string;
  expiresInSec: number;
  expiresAt: string;
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorage,
    private readonly permissions: PermissionService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * A 5 minute GET URL for the invoice PDF. Only the buyer, a user who is the seller, or someone with billing.view_any may have it;
   * for everyone else the invoice does not exist (404), never a hint that it does.
   */
  async downloadUrl(userId: string, invoiceId: string): Promise<DownloadLink> {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    return this.link(userId, invoice, "Invoice", "INVOICE_NOT_FOUND", "INVOICE_NOT_READY");
  }

  /** The credit note PDF of a refunded order: the same people may have it as the invoice. */
  async creditNoteUrl(userId: string, creditNoteId: string): Promise<DownloadLink> {
    const note = await this.prisma.creditNote.findUnique({ where: { id: creditNoteId } });
    return this.link(userId, note, "Credit note", "CREDIT_NOTE_NOT_FOUND", "CREDIT_NOTE_NOT_READY");
  }

  private async link(
    userId: string,
    doc: { number: string; objectKey: string; uploadedAt: Date | null; buyerUserId: string | null; sellerOwnerType: string | null; sellerOwnerId: string | null } | null,
    label: string,
    notFound: string,
    notReady: string,
  ): Promise<DownloadLink> {
    const mine = !!doc && (doc.buyerUserId === userId || (doc.sellerOwnerType === "USER" && doc.sellerOwnerId === userId));
    if (!doc || !(mine || (await this.permissions.has(userId, "billing.view_any")))) throw new AppError(notFound, 404, `${label} not found`);
    if (!doc.uploadedAt) throw new AppError(notReady, 409, `The ${label.toLowerCase()} is still being prepared; try again shortly`);
    const url = await this.storage.presignPrivateGet(doc.objectKey, { expiresInSec: INVOICE_URL_TTL_SEC, filename: `${doc.number.replaceAll("/", "-")}.pdf` });
    return { url, expiresInSec: INVOICE_URL_TTL_SEC, expiresAt: new Date(this.clock.now().getTime() + INVOICE_URL_TTL_SEC * 1000).toISOString() };
  }
}
