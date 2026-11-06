import type { Campaign } from "@prisma/client";
import { contentHash, isApproved, lastEditor, mayApprove } from "./campaign-approval";

const base = (over: Partial<Campaign> = {}): Campaign =>
  ({ id: "c", name: "n", subject: "Hello", bodyMarkdown: "Body", segment: { plan: ["pro"], roles: ["creator"] }, createdById: "creator", lastEditedById: "creator", approvedById: null, approvedAt: null, approvalHash: null, ...over }) as Campaign;
const approvedBy = (who: string, c: Campaign) => ({ ...c, approvedById: who, approvalHash: contentHash(c) });

describe("campaign approval", () => {
  it("the hash covers subject, body and segment, and does not care about key order", () => {
    const c = base();
    expect(contentHash(c)).toBe(contentHash(base({ segment: { roles: ["creator"], plan: ["pro"] } })));
    expect(contentHash(c)).not.toBe(contentHash(base({ subject: "Hello!" })));
    expect(contentHash(c)).not.toBe(contentHash(base({ bodyMarkdown: "Other" })));
    expect(contentHash(c)).not.toBe(contentHash(base({ segment: {} })));
  });

  it("neither the creator nor the last editor may approve; the last editor of an old row is its creator", () => {
    const c = base({ lastEditedById: "editor" });
    expect([mayApprove(c, "creator"), mayApprove(c, "editor"), mayApprove(c, "third")]).toEqual([false, false, true]);
    expect(lastEditor(base({ lastEditedById: null }))).toBe("creator");
  });

  it("counts only when someone allowed approved exactly this content", () => {
    const c = base({ lastEditedById: "editor" });
    expect(isApproved(base())).toBe(false);
    expect(isApproved(approvedBy("third", c))).toBe(true);
    expect(isApproved(approvedBy("editor", c))).toBe(false);
    expect(isApproved(approvedBy("creator", c))).toBe(false);
    expect(isApproved({ ...approvedBy("third", c), subject: "Changed behind the back" })).toBe(false);
    expect(isApproved({ ...approvedBy("third", c), approvalHash: null })).toBe(false);
  });
});
