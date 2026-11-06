import { createHash } from "node:crypto";
import type { Campaign } from "@prisma/client";

type Content = Pick<Campaign, "subject" | "bodyMarkdown" | "segment">;

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v)]))
      : value;

/** SHA-256 of what a second admin approves: the subject, the body and the segment. Key order in the segment does not matter. */
export function contentHash(c: Content): string {
  return createHash("sha256").update(JSON.stringify({ subject: c.subject, bodyMarkdown: c.bodyMarkdown, segment: canonical(c.segment) })).digest("hex");
}

/** Whoever last changed the draft: the creator until someone else edits it. */
export const lastEditor = (c: Pick<Campaign, "createdById" | "lastEditedById">): string => c.lastEditedById ?? c.createdById;

/** An admin who made or last changed a campaign cannot be the one who approves it. */
export const mayApprove = (c: Pick<Campaign, "createdById" | "lastEditedById">, actorId: string): boolean => actorId !== c.createdById && actorId !== lastEditor(c);

/**
 * True only when someone other than the creator and the last editor approved this exact content. An edit clears the approval, and the hash
 * also catches a change that reached the row any other way: the approval is for the text and audience the approver saw.
 */
export function isApproved(c: Campaign): boolean {
  return c.approvedById !== null && mayApprove(c, c.approvedById) && c.approvalHash !== null && c.approvalHash === contentHash(c);
}
