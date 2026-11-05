import { Injectable, OnModuleInit } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ModerationTargetRegistry } from "../moderation";

/**
 * Messages as reportable content (GIG_MESSAGE). Only the OTHER participant of the conversation can report a message (canReport), so a stranger cannot
 * even learn that a message exists. Moderators see a message's text only in the queue entry of a message somebody reported (preview); there is no other
 * way for them to read a conversation. A hidden or removed message keeps its place in the thread without its text (message-view).
 */
@Injectable()
export class MessagingModerationTargets implements OnModuleInit {
  constructor(
    private readonly registry: ModerationTargetRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.registry.register({
      type: "GIG_MESSAGE",
      ownerOf: async (id) => (await this.prisma.message.findUnique({ where: { id }, select: { senderId: true } }))?.senderId ?? null,
      reportable: async (id) => {
        const m = await this.prisma.message.findUnique({ where: { id }, select: { status: true } });
        return m?.status === "VISIBLE" || m?.status === "HIDDEN";
      },
      canReport: async (id, reporterId) => {
        const m = await this.prisma.message.findUnique({ where: { id }, select: { conversationId: true } });
        return !!m && (await this.prisma.conversationParticipant.count({ where: { conversationId: m.conversationId, userId: reporterId } })) > 0;
      },
      hide: (tx, id) => this.move(tx, id, ["VISIBLE"], "HIDDEN"),
      remove: (tx, id) => this.move(tx, id, ["VISIBLE", "HIDDEN"], "REMOVED"),
      restore: (tx, id) => this.move(tx, id, ["HIDDEN"], "VISIBLE"),
      preview: async (id) => {
        const m = await this.prisma.message.findUnique({ where: { id }, select: { body: true, status: true } });
        return m ? { text: m.body, status: m.status } : null;
      },
    });
  }

  private async move(tx: Prisma.TransactionClient, id: string, from: Array<"VISIBLE" | "HIDDEN">, to: "VISIBLE" | "HIDDEN" | "REMOVED"): Promise<boolean> {
    const changed = await tx.message.updateMany({ where: { id, status: { in: from } }, data: { status: to } });
    return changed.count === 1;
  }
}
