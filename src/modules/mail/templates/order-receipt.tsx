import { Text } from "@react-email/components";
import type { MailData } from "../mail.types";
import { Layout } from "./layout";

export const orderReceiptSubject = (data: MailData["order_receipt"]) => `Your receipt for ${data.itemTitle}`;

export function OrderReceipt({ orderId, itemTitle, amount, paidOn }: MailData["order_receipt"]) {
  return (
    <Layout preview={`Payment received for ${itemTitle}`} title="Thanks for your purchase">
      <Text>We received your payment for {itemTitle}.</Text>
      <Text>Amount paid: {amount}</Text>
      <Text>Date: {paidOn}</Text>
      <Text>Order reference: {orderId}</Text>
    </Layout>
  );
}
