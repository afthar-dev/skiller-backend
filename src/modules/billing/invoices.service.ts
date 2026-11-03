import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ObjectStorage } from "../media";
import { PermissionService } from "../rbac";

export const INVOICE_URL_TTL_SEC = 5 * 60;

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
  async downloadUrl(userId: string, invoiceId: string): Promise<{ url: string; expiresInSec: number; expiresAt: string }> {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    const mine = !!invoice && (invoice.buyerUserId === userId || (invoice.sellerOwnerType === "USER" && invoice.sellerOwnerId === userId));
    if (!invoice || !(mine || (await this.permissions.has(userId, "billing.view_any")))) throw new AppError("INVOICE_NOT_FOUND", 404, "Invoice not found");
    if (!invoice.uploadedAt) throw new AppError("INVOICE_NOT_READY", 409, "The invoice is still being prepared; try again shortly");
    const url = await this.storage.presignPrivateGet(invoice.objectKey, { expiresInSec: INVOICE_URL_TTL_SEC, filename: `${invoice.number.replace(/\//g, "-")}.pdf` });
    return { url, expiresInSec: INVOICE_URL_TTL_SEC, expiresAt: new Date(this.clock.now().getTime() + INVOICE_URL_TTL_SEC * 1000).toISOString() };
  }
}
