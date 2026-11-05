import { Injectable } from "@nestjs/common";
import type { Prisma, ReportTargetType } from "@prisma/client";

/**
 * What the moderation module needs from whoever owns reportable content. The owner registers one adapter per target type at start-up; the
 * moderation module never reads the owner's tables. `tx` is the moderation transaction: the content change commits with the decision.
 * Each change returns whether it really changed something, so a repeated call is harmless.
 */
export interface ModerationTarget {
  type: ReportTargetType;
  /** The author of content that can still be moderated (live or already held back); null when it does not exist or is gone for good. */
  ownerOf(id: string): Promise<string | null>;
  /** Held back pending review (auto-hide). */
  hide(tx: Prisma.TransactionClient, id: string): Promise<boolean>;
  /** Taken down for good (an upheld report). Works on live and on held-back content. */
  remove(tx: Prisma.TransactionClient, id: string): Promise<boolean>;
  /** Brings held-back content back (a dismissed report). */
  restore(tx: Prisma.TransactionClient, id: string): Promise<boolean>;
  /** True when `actorId` has a stake in the content beyond writing it (authors the course it sits in): they may not decide on it. */
  conflictsWith?(id: string, actorId: string): Promise<boolean>;
  /** A short description for the moderator's queue. */
  preview?(id: string): Promise<{ text: string; status: string } | null>;
}

@Injectable()
export class ModerationTargetRegistry {
  private readonly targets = new Map<ReportTargetType, ModerationTarget>();

  register(target: ModerationTarget): void {
    this.targets.set(target.type, target);
  }

  get(type: ReportTargetType): ModerationTarget | undefined {
    return this.targets.get(type);
  }
}
