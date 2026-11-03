import { randomUUID } from "node:crypto";
import request from "supertest";
import type { PrismaService } from "../../src/common/prisma/prisma.service";
import type { FakeRazorpayClient } from "../../src/modules/billing";
import type { AuthTestApp } from "./auth-app";
import { createTestItem } from "./test-item";

export type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

/** A seller, a buyer and one TEST_ITEM order paid end to end (checkout, captured payment, verify): the sale is posted to the ledger. */
export async function paidOrder(
  t: AuthTestApp,
  fake: FakeRazorpayClient,
  opts: { pricePaise?: bigint; seller?: Session; buyer?: Session; title?: string } = {},
) {
  const http = () => request(t.app.getHttpServer());
  const auth = (s: Session) => ({ Authorization: `Bearer ${s.accessToken}` });
  const seller = opts.seller ?? (await t.login());
  const buyer = opts.buyer ?? (await t.login());
  const itemId = createTestItem({ sellerOwnerId: seller.userId, pricePaise: opts.pricePaise ?? 100000n, ...(opts.title ? { title: opts.title } : {}) });
  const started = await http().post("/v1/checkout").set(auth(buyer)).set("Idempotency-Key", randomUUID()).send({ itemType: "TEST_ITEM", itemId });
  if (started.status !== 201) throw new Error(`checkout failed: ${started.status} ${JSON.stringify(started.body)}`);
  const { orderId, razorpayOrderId } = started.body as { orderId: string; razorpayOrderId: string };
  const payment = fake.capturePayment(razorpayOrderId);
  const verified = await http().post("/v1/checkout/verify").set(auth(buyer)).send({ orderId, razorpayOrderId, razorpayPaymentId: payment.id, signature: fake.paymentSignature(razorpayOrderId, payment.id) });
  if (verified.status !== 200) throw new Error(`verify failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  return { seller, buyer, itemId, orderId, razorpayOrderId, paymentId: payment.id };
}

/** Kinds and signed amounts of one journal entry's lines, summed per account kind (the seller is told apart by owner). */
export async function entryLines(prisma: PrismaService, orderId: string, description: string) {
  const entry = await prisma.journalEntry.findUnique({ where: { refType_refId_description: { refType: "ORDER", refId: orderId, description } }, include: { lines: { include: { account: true } } } });
  if (!entry) return null;
  const byKind: Record<string, bigint> = {};
  for (const l of entry.lines) byKind[l.account.kind] = (byKind[l.account.kind] ?? 0n) + l.amountPaise;
  return { entry, byKind, sum: entry.lines.reduce((s, l) => s + l.amountPaise, 0n) };
}
