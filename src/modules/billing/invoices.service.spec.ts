import { InvoicesService } from "./invoices.service";

/** MON-8: organisation invoices are downloadable by members with org.manage, not only the one who clicked checkout. */
describe("InvoicesService.downloadUrl for organisations", () => {
  const base = { number: "SKL/26-27/000001", objectKey: "invoices/i.pdf", uploadedAt: new Date(), buyerUserId: "buyer", sellerOwnerType: null, sellerOwnerId: null, subscriptionId: null };
  function setup(invoice: Record<string, unknown>, opts: { orgManagers?: string[]; subscription?: { ownerType: string; ownerId: string } | null; viewAny?: boolean } = {}) {
    const prisma = { invoice: { findUnique: async () => invoice }, creditNote: { findUnique: async () => invoice }, subscription: { findUnique: async () => opts.subscription ?? null } };
    const permissions = {
      has: async (userId: string, key: string, orgId?: string) => (key === "billing.view_any" ? !!opts.viewAny : key === "org.manage" && orgId === "ORG1" && !!opts.orgManagers?.includes(userId)),
    };
    const storage = { presignPrivateGet: async () => "https://example.test/x" };
    return new InvoicesService(prisma as never, storage as never, permissions as never, { now: () => new Date() } as never);
  }

  it("an org admin who did not check out downloads the subscription invoice", async () => {
    const svc = setup({ ...base, subscriptionId: "S1" }, { orgManagers: ["admin2"], subscription: { ownerType: "ORG", ownerId: "ORG1" } });
    await expect(svc.downloadUrl("admin2", "I1")).resolves.toMatchObject({ url: "https://example.test/x" });
  });
  it("an org member with org.manage downloads an invoice for an ORG seller's sale", async () => {
    const svc = setup({ ...base, sellerOwnerType: "ORG", sellerOwnerId: "ORG1" }, { orgManagers: ["admin2"] });
    await expect(svc.downloadUrl("admin2", "I1")).resolves.toMatchObject({ url: "https://example.test/x" });
  });
  it("a stranger and a member without org.manage still get 404", async () => {
    const svc = setup({ ...base, subscriptionId: "S1" }, { orgManagers: ["admin2"], subscription: { ownerType: "ORG", ownerId: "ORG1" } });
    await expect(svc.downloadUrl("stranger", "I1")).rejects.toMatchObject({ status: 404 });
  });
  it("the buyer still downloads", async () => {
    await expect(setup(base).downloadUrl("buyer", "I1")).resolves.toBeDefined();
  });
});
