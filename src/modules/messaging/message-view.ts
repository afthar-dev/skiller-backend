import type { Message } from "@prisma/client";
import type { ProfileSummary } from "../users";

/** A message as clients see it. Text is shown only while the message is VISIBLE: a hidden or removed one keeps its place in the thread without its words, for both sides. */
export interface MessageView {
  id: string;
  conversationId: string;
  senderId: string;
  body: string | null;
  status: Message["status"];
  createdAt: string;
}

export const toMessageView = (m: Pick<Message, "id" | "conversationId" | "senderId" | "body" | "status" | "createdAt">): MessageView => ({
  id: m.id,
  conversationId: m.conversationId,
  senderId: m.senderId,
  body: m.status === "VISIBLE" ? m.body : null,
  status: m.status,
  createdAt: m.createdAt.toISOString(),
});

export interface ConversationView {
  id: string;
  gigId: string | null;
  /** The gig the conversation is about, while it still exists (live or paused). */
  gig: { id: string; slug: string; title: string } | null;
  /** Set for gig conversations: Skiller does not take part in the deal. */
  paymentNotice: string | null;
  lastMessageAt: string;
  unreadCount: number;
  archived: boolean;
  counterpart: ProfileSummary | null;
  lastMessage: MessageView | null;
}
