import { randomUUID } from "node:crypto";
import { EventBus } from "../../src/common/outbox/event-bus";
import { AppError } from "../../src/common/errors/app-error";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { FakeRazorpayXClient, PAYOUT_ACCOUNT_COOLDOWN, PayoutAccountsService, RAZORPAYX_CLIENT, RazorpayApiError } from "../../src/modules/billing";
import { RolesService } from "../../src/modules/rbac";
import { createAuthTestApp, type AuthTestApp } from "../support/auth-app";
import { DAY, payoutHelpers, randomAccountNumber, randomPan, until } from "../support/payouts";

describe("payout accounts and KYC", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let accounts: PayoutAccountsService;
  let h: ReturnType<typeof payoutHelpers>;
  const fakeX = new FakeRazorpayXClient({ webhookSecret: "razorpayx-webhook-secret-for-tests" });

  beforeAll(async () => {
    t = await createAuthTestApp({}, (b) => b.overrideProvider(RAZORPAYX_CLIENT).useValue(fakeX));
    prisma = t.app.get(PrismaService);
    accounts = t.app.get(PayoutAccountsService);
    h = payoutHelpers(t, prisma, fakeX);
  });
  afterAll(() => t?.close());

  /** Everything the process writes to stdout/stderr while `run` executes (Nest's logger and any console output). */
  async function captureOutput<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
    const chunks: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: unknown, ...rest: unknown[]) => (chunks.push(String(c)), (out as (...a: unknown[]) => boolean)(c, ...rest))) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown, ...rest: unknown[]) => (chunks.push(String(c)), (err as (...a: unknown[]) => boolean)(c, ...rest))) as typeof process.stderr.write;
    try {
      return { result: await run(), output: chunks.join("") };
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
  }

  /** Replays the account-change outbox event like the relay would. */
  async function replayChange(accountId: string) {
    const row = (await prisma.outboxEvent.findMany({ where: { type: "payout_account.changed" } })).find((x) => (x.payload as { payoutAccountId?: string }).payoutAccountId === accountId);
    if (!row) throw new Error(`no payout_account.changed outbox row for ${accountId}`);
    await t.app.get(EventBus).dispatch({ type: "payout_account.changed", ...(row.payload as object) } as Parameters<EventBus["dispatch"]>[0], row.id);
  }

  const rawRow = async (id: string) => (await prisma.$queryRaw<{ j: string }[]>`SELECT to_jsonb(p)::text AS j FROM payout_accounts p WHERE p.id = ${id}`)[0].j;

  describe("PUT /v1/wallet/payout-account", () => {
    it("stores masked details only: raw rows, audit rows, stored webhooks and captured logs never contain the full account number or PAN", async () => {
      const s = await h.creator();
      await h.stepUp(s);
      const accountNumber = randomAccountNumber();
      const pan = randomPan();
      const { result: res, output } = await captureOutput(async () => {
        const ok = await h.putAccount(s, h.bankBody({ accountNumber, pan }));
        // A malformed request and a provider refusal go through the error paths, which must not echo the values either.
        await h.putAccount(s, { ...h.bankBody({ accountNumber, pan }), pan: pan + "X" });
        fakeX.failNext.set("createFundAccount", new RazorpayApiError(400, "BAD_REQUEST_ERROR", `Invalid account ${accountNumber}`));
        await h.putAccount(s, h.bankBody({ accountNumber, pan }));
        fakeX.failNext.set("createContact", new Error(`connect ECONNRESET for ${accountNumber}`));
        await h.putAccount(s, h.bankBody({ accountNumber, pan }));
        return ok;
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ type: "BANK", status: "PENDING", ifsc: "HDFC0001234", accountLast4: accountNumber.slice(-4), panLast4: pan.slice(-4), holderName: "Asha Rao" });
      expect(res.body.cooldownEndsAt).toBe(t.clock.now().toISOString()); // a first account has no cooldown
      expect(JSON.stringify(res.body)).not.toContain(accountNumber);
      expect(JSON.stringify(res.body)).not.toContain(pan);

      // RazorpayX received the full values ...
      const sent = [...fakeX.fundAccounts.values()].find((f) => f.bank?.accountNumber === accountNumber);
      expect(sent?.bank).toMatchObject({ ifsc: "HDFC0001234", name: "Asha Rao" });
      // ... and nothing we keep has them.
      const row = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.razorpayxFundAccountId).toBe(sent!.id);
      const raw = await rawRow(row.id);
      expect(raw).not.toContain(accountNumber);
      expect(raw).not.toContain(pan);
      expect(raw).toContain(accountNumber.slice(-4));
      const audits = JSON.stringify(await prisma.auditLog.findMany({ where: { targetType: "payout_account", targetId: row.id } }));
      expect(audits).toContain("payout_account.change");
      expect(audits).not.toContain(accountNumber);
      expect(audits).not.toContain(pan);
      expect(output).not.toContain(accountNumber);
      expect(output).not.toContain(pan);

      // The validation event RazorpayX sends carries the account number in full: it is cut before it is stored.
      const hook = fakeX.validationWebhook(row.razorpayxFundAccountId, "active");
      expect(hook.body).toContain(accountNumber);
      const stored = await h.deliverX(hook);
      const payloadText = JSON.stringify((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: stored.id } })).payload);
      expect(payloadText).not.toContain(accountNumber);
      expect(payloadText).toContain(`****${accountNumber.slice(-4)}`);
    });

    it("stores a UPI id masked", async () => {
      const s = await h.creator();
      await h.stepUp(s);
      const vpa = `asha${randomUUID().slice(0, 6)}@okhdfc`;
      const pan = randomPan();
      const res = await h.putAccount(s, h.upiBody(vpa, pan));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ type: "UPI", vpaMasked: `as***@okhdfc`, accountLast4: null, ifsc: null, panLast4: pan.slice(-4) });
      const raw = await rawRow(res.body.id);
      expect(raw).not.toContain(vpa);
      expect(raw).not.toContain(pan);
      const sentFa = [...fakeX.fundAccounts.values()].find((f) => f.vpa?.address === vpa);
      expect(sentFa).toBeDefined();

      // The validation event carries the VPA as { username, handle, address }: none of the three parts may be stored.
      const hook = fakeX.validationWebhook(sentFa!.id, "active");
      expect(hook.body).toContain(`"username":"${vpa.split("@")[0]}"`);
      const stored = await h.deliverX(hook);
      const payloadText = JSON.stringify((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: stored.id } })).payload);
      expect(payloadText).not.toContain(vpa);
      expect(payloadText).not.toContain(vpa.split("@")[0]);
      expect(payloadText).toContain("as***@okhdfc");
    });

    it("needs a creator, a fresh step-up, a valid body and authentication", async () => {
      const plain = await t.login();
      await h.stepUp(plain);
      const notCreator = await h.putAccount(plain, h.bankBody());
      expect(notCreator.status).toBe(403);
      expect(notCreator.body.error.code).toBe("CREATOR_REQUIRED");

      const s = await h.creator();
      const noStepUp = await h.putAccount(s, h.bankBody());
      expect(noStepUp.status).toBe(403);
      expect(noStepUp.body.error.code).toBe("STEP_UP_REQUIRED");
      expect((await h.http().put("/v1/wallet/payout-account").send(h.bankBody())).status).toBe(401);

      await h.stepUp(s);
      for (const bad of [
        { ...h.bankBody(), pan: "NOTAPAN" },
        { ...h.bankBody(), pan: undefined },
        { ...h.bankBody(), bank: { ifsc: "BAD", accountNumber: "123456789012", holderName: "A B" } },
        { ...h.bankBody(), bank: { ifsc: "HDFC0001234", accountNumber: "12ab", holderName: "A B" } },
        { type: "BANK", pan: randomPan() },
        { ...h.bankBody(), upi: { vpa: "a@b" } },
        { ...h.upiBody(), bank: h.bankBody().bank },
        { ...h.upiBody("not-a-vpa") },
        { ...h.bankBody(), extra: 1 },
      ]) {
        const res = await h.putAccount(s, bad);
        expect(res.status).toBe(400);
      }
      expect(await prisma.payoutAccount.count({ where: { createdBy: s.userId } })).toBe(0);
    });

    it("an organization's owner sets the organization's account through the org route; other members and strangers cannot", async () => {
      const owner = await t.login();
      const org = (await h.http().post("/v1/orgs").set(h.auth(owner)).send({ name: "Payout Org", slug: `po-${h.uid()}` })).body as { id: string; slug: string };
      const stranger = await t.login();
      await h.stepUp(stranger);
      expect((await h.http().put(`/v1/orgs/${org.slug}/wallet/payout-account`).set(h.auth(stranger)).send(h.bankBody())).status).toBe(403);
      expect((await h.http().get(`/v1/orgs/${org.slug}/wallet/payout-account`).set(h.auth(stranger))).status).toBe(403);

      expect((await h.http().put(`/v1/orgs/${org.slug}/wallet/payout-account`).set(h.auth(owner)).send(h.bankBody())).body.error.code).toBe("STEP_UP_REQUIRED");
      await h.stepUp(owner);
      const res = await h.http().put(`/v1/orgs/${org.slug}/wallet/payout-account`).set(h.auth(owner)).send(h.bankBody());
      expect(res.status).toBe(200);
      const row = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row).toMatchObject({ ownerType: "ORG", ownerId: org.id, createdBy: owner.userId });
      const got = await h.http().get(`/v1/orgs/${org.slug}/wallet/payout-account`).set(h.auth(owner));
      expect(got.body.account.id).toBe(res.body.id);
      expect((await h.http().put("/v1/orgs/nope-nope/wallet/payout-account").set(h.auth(owner)).send(h.bankBody())).status).toBe(403);
    });

    it("a provider outage changes nothing (502) and a refusal is a 422 that does not echo the provider's text", async () => {
      const s = await h.creator();
      await h.stepUp(s);
      const first = await h.putAccount(s, h.bankBody());
      expect(first.status).toBe(200);

      fakeX.failNext.set("createFundAccount", new Error("socket hang up"));
      const down = await h.putAccount(s, h.bankBody());
      expect(down.status).toBe(502);
      expect(down.body.error.code).toBe("PAYOUT_GATEWAY_ERROR");
      fakeX.failNext.set("validateFundAccount", new RazorpayApiError(400, "BAD_REQUEST_ERROR", "Invalid IFSC for account 1234567890123"));
      const refused = await h.putAccount(s, h.bankBody());
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe("PAYOUT_ACCOUNT_REJECTED");
      expect(JSON.stringify(refused.body)).not.toContain("1234567890123");

      const live = await prisma.payoutAccount.findMany({ where: { createdBy: s.userId, status: { not: "INACTIVE" } } });
      expect(live.map((a) => a.id)).toEqual([first.body.id]);
    });

    it("two simultaneous changes leave exactly one live account", async () => {
      const s = await h.creator();
      await h.stepUp(s);
      const results = await Promise.all([h.putAccount(s, h.bankBody()), h.putAccount(s, h.bankBody()), h.putAccount(s, h.bankBody())]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      const rows = await prisma.payoutAccount.findMany({ where: { createdBy: s.userId } });
      expect(rows).toHaveLength(3);
      expect(rows.filter((r) => r.status !== "INACTIVE")).toHaveLength(1);
    });
  });

  describe("validation", () => {
    it("fund_account.validation.completed (active) verifies the account; a repeat is a no-op; the cooldown is measured from the change", async () => {
      const s = await h.creator();
      await h.stepUp(s);
      const res = await h.putAccount(s, h.bankBody());
      const row = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.status).toBe("PENDING");
      const hook = fakeX.validationWebhook(row.razorpayxFundAccountId, "active");
      await h.deliverX(hook);
      const verified = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: row.id } });
      expect(verified).toMatchObject({ status: "VERIFIED", panNameMatch: true });
      expect(verified.verifiedAt).not.toBeNull();
      const before = verified.verifiedAt!.getTime();
      t.clock.advance(1000);
      await h.deliverX(fakeX.validationWebhook(row.razorpayxFundAccountId, "active", { registeredName: "Asha Rao (again)" })); // a different event, same fact
      expect((await prisma.payoutAccount.findUniqueOrThrow({ where: { id: row.id } })).verifiedAt!.getTime()).toBe(before);
      // The very same event delivered again is acknowledged without a second row.
      const again = await h.http().post("/v1/webhooks/razorpayx").set(hook.headers).send(hook.body);
      expect(again.status).toBe(200);
      expect(await prisma.webhookEvent.count({ where: { provider: "RAZORPAYX", eventId: hook.headers["x-razorpay-event-id"] } })).toBe(1);
    });

    it("an invalid account or a failed validation marks the account FAILED; a different holder name sets panNameMatch=false and flags it for review", async () => {
      const s = await h.creator();
      await h.stepUp(s);
      const a = await h.putAccount(s, h.bankBody());
      const rowA = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: a.body.id } });
      await h.deliverX(fakeX.validationWebhook(rowA.razorpayxFundAccountId, "invalid"));
      expect(await prisma.payoutAccount.findUniqueOrThrow({ where: { id: rowA.id } })).toMatchObject({ status: "FAILED" });

      const b = await h.putAccount(s, h.bankBody());
      const rowB = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: b.body.id } });
      await h.deliverX(fakeX.validationWebhook(rowB.razorpayxFundAccountId, "failed"));
      expect(await prisma.payoutAccount.findUniqueOrThrow({ where: { id: rowB.id } })).toMatchObject({ status: "FAILED" });

      const c = await h.putAccount(s, h.bankBody({ holderName: "Asha Rao" }));
      const rowC = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: c.body.id } });
      await h.deliverX(fakeX.validationWebhook(rowC.razorpayxFundAccountId, "active", { registeredName: "Somebody Else" }));
      expect(await prisma.payoutAccount.findUniqueOrThrow({ where: { id: rowC.id } })).toMatchObject({ status: "VERIFIED", panNameMatch: false, reviewFlag: "NAME_MISMATCH" });
    });

    it("a result for an account that was replaced meanwhile changes nothing", async () => {
      const s = await h.creator();
      await h.stepUp(s);
      const first = await h.putAccount(s, h.bankBody());
      const second = await h.putAccount(s, h.bankBody());
      const rowFirst = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: first.body.id } });
      await h.deliverX(fakeX.validationWebhook(rowFirst.razorpayxFundAccountId, "active"));
      expect(await prisma.payoutAccount.findUniqueOrThrow({ where: { id: first.body.id } })).toMatchObject({ status: "INACTIVE" });
      expect(await prisma.payoutAccount.findUniqueOrThrow({ where: { id: second.body.id } })).toMatchObject({ status: "PENDING" });
    });
  });

  describe("changing the account (cooldown)", () => {
    it("retires the old account, resets VERIFIED and blocks payouts for 24 hours counted on the Clock", async () => {
      const s = await h.creator();
      await h.stepUp(s);
      const owner = { ownerType: "USER" as const, ownerId: s.userId };
      const first = await h.putAccount(s, h.bankBody());
      await h.deliverX(fakeX.validationWebhook((await prisma.payoutAccount.findUniqueOrThrow({ where: { id: first.body.id } })).razorpayxFundAccountId, "active"));
      // The first account is payable as soon as it is verified: there is nothing to be hijacked from.
      expect((await accounts.payableAccount(owner)).id).toBe(first.body.id);

      // Change: new row PENDING (not payable), old row INACTIVE, the 24 h pause starts.
      const second = await h.putAccount(s, h.bankBody());
      expect(second.status).toBe(200);
      expect(await prisma.payoutAccount.findUniqueOrThrow({ where: { id: first.body.id } })).toMatchObject({ status: "INACTIVE" });
      expect(await prisma.payoutAccount.findUniqueOrThrow({ where: { id: second.body.id } })).toMatchObject({ status: "PENDING" });
      await expect(accounts.payableAccount(owner)).rejects.toMatchObject({ code: "PAYOUT_ACCOUNT_NOT_VERIFIED" });
      await h.deliverX(fakeX.validationWebhook((await prisma.payoutAccount.findUniqueOrThrow({ where: { id: second.body.id } })).razorpayxFundAccountId, "active"));
      const blocked = await accounts.payableAccount(owner).catch((e: AppError) => e);
      expect(blocked).toMatchObject({ code: "PAYOUT_ACCOUNT_COOLDOWN", status: 409 });
      t.clock.advance(PAYOUT_ACCOUNT_COOLDOWN - 1000);
      await expect(accounts.payableAccount(owner)).rejects.toMatchObject({ code: "PAYOUT_ACCOUNT_COOLDOWN" });
      t.clock.advance(1000);
      expect((await accounts.payableAccount(owner)).id).toBe(second.body.id);
    });

    it("an owner without an account, or whose account failed validation, cannot be paid", async () => {
      const s = await h.creator();
      const owner = { ownerType: "USER" as const, ownerId: s.userId };
      await expect(accounts.payableAccount(owner)).rejects.toMatchObject({ code: "PAYOUT_ACCOUNT_REQUIRED" });
      await h.stepUp(s);
      const res = await h.putAccount(s, h.bankBody());
      await h.deliverX(fakeX.validationWebhook((await prisma.payoutAccount.findUniqueOrThrow({ where: { id: res.body.id } })).razorpayxFundAccountId, "invalid"));
      t.clock.advance(DAY + 1000);
      await expect(accounts.payableAccount(owner)).rejects.toMatchObject({ code: "PAYOUT_ACCOUNT_NOT_VERIFIED" });
    });

    it("GET returns the current account masked, and null for an owner with none", async () => {
      const s = await h.creator();
      expect((await h.http().get("/v1/wallet/payout-account").set(h.auth(s))).body).toEqual({ account: null });
      await h.stepUp(s);
      const res = await h.putAccount(s, h.bankBody());
      const got = await h.http().get("/v1/wallet/payout-account").set(h.auth(s));
      expect(got.body.account).toEqual(res.body);
      const plain = await t.login();
      expect((await h.http().get("/v1/wallet/payout-account").set(h.auth(plain))).status).toBe(403);
    });
  });

  describe("owner notification on change", () => {
    it("a creator is told by in-app message and email, with the cooldown end, whenever the account is replaced", async () => {
      const s = await h.creator();
      await h.stepUp(s);
      const first = await h.putAccount(s, h.bankBody());
      expect(first.status).toBe(200);
      const second = await h.putAccount(s, h.bankBody());
      await replayChange(first.body.id);
      await replayChange(second.body.id);
      await replayChange(second.body.id); // at-least-once redelivery: no duplicates
      const row = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: second.body.id } });
      const notes = await prisma.notification.findMany({ where: { userId: s.userId, type: "payout_account.changed" }, orderBy: { id: "asc" } });
      expect(notes).toHaveLength(2);
      expect(notes[1].body).toContain("24 hours");
      expect(JSON.stringify(notes[1].data)).toContain(row.cooldownUntil.toISOString());
      const mail = await until(async () => t.mail.sent.filter((m) => m.to === s.email && /payout account/i.test(m.subject)).length >= 2 && t.mail.sent.filter((m) => m.to === s.email && /payout account/i.test(m.subject))[1]);
      expect(mail.html).toContain("IST");
      expect(t.mail.sent.filter((m) => m.to === s.email && /payout account/i.test(m.subject))).toHaveLength(2);
    });

    it("an organization's account change goes to every org_owner, not only the actor", async () => {
      const ownerS = await t.login();
      const org = (await h.http().post("/v1/orgs").set(h.auth(ownerS)).send({ name: "Notify Org", slug: `nt-${h.uid()}` })).body as { id: string; slug: string };
      const second = await t.login();
      await t.app.get(RolesService).grantSystem(second.userId, "org_owner", undefined, org.id);
      await h.stepUp(ownerS);
      const res = await h.http().put(`/v1/orgs/${org.slug}/wallet/payout-account`).set(h.auth(ownerS)).send(h.bankBody());
      expect(res.status).toBe(200);
      await replayChange(res.body.id);
      for (const u of [ownerS.userId, second.userId]) expect(await prisma.notification.count({ where: { userId: u, type: "payout_account.changed" } })).toBe(1);
    });
  });

  describe("duplicate PAN", () => {
    it("the same PAN on two owners flags both accounts for finance review without blocking either, and tells finance", async () => {
      const finance = await t.login();
      await t.app.get(RolesService).grantSystem(finance.userId, "finance_admin");
      const pan = randomPan();
      const a = await h.creator();
      await h.stepUp(a);
      const first = await h.putAccount(a, h.bankBody({ pan }));
      expect(first.status).toBe(200);
      expect((await prisma.payoutAccount.findUniqueOrThrow({ where: { id: first.body.id } })).reviewFlag).toBeNull();

      const b = await h.creator();
      await h.stepUp(b);
      const second = await h.putAccount(b, h.bankBody({ pan }));
      expect(second.status).toBe(200); // not blocked
      expect(second.body.status).toBe("PENDING");
      expect(await prisma.payoutAccount.findUniqueOrThrow({ where: { id: first.body.id } })).toMatchObject({ reviewFlag: "DUPLICATE_PAN" });
      expect(await prisma.payoutAccount.findUniqueOrThrow({ where: { id: second.body.id } })).toMatchObject({ reviewFlag: "DUPLICATE_PAN" });
      // The flag is not shown to the owner.
      expect(JSON.stringify(second.body)).not.toContain("DUPLICATE_PAN");

      const note = await until(() => prisma.notification.findFirst({ where: { userId: finance.userId, type: "finance.alert", sourceEventId: `finance:duplicate-pan:${second.body.id}` } }));
      expect(note.body).toContain(`ending ${pan.slice(-4)}`);
      expect(note.body).not.toContain(pan);

      const listed = await h.http().get("/v1/admin/payout-accounts?flagged=true&limit=100").set(h.auth(finance));
      expect(listed.status).toBe(200);
      const ids = (listed.body.items as { id: string; reviewFlag: string; ownerId: string }[]).map((x) => x.id);
      expect(ids).toEqual(expect.arrayContaining([first.body.id, second.body.id]));
      expect(JSON.stringify(listed.body)).not.toContain(pan);
      expect((await h.http().get("/v1/admin/payout-accounts").set(h.auth(a))).status).toBe(403);
    });

    it("the same owner re-entering their own PAN is not a duplicate, and a different PAN is not flagged", async () => {
      const pan = randomPan();
      const s = await h.creator();
      await h.stepUp(s);
      await h.putAccount(s, h.bankBody({ pan }));
      const again = await h.putAccount(s, h.bankBody({ pan }));
      expect((await prisma.payoutAccount.findUniqueOrThrow({ where: { id: again.body.id } })).reviewFlag).toBeNull();
      const other = await h.creator();
      await h.stepUp(other);
      const o = await h.putAccount(other, h.bankBody());
      expect((await prisma.payoutAccount.findUniqueOrThrow({ where: { id: o.body.id } })).reviewFlag).toBeNull();
    });
  });
});
