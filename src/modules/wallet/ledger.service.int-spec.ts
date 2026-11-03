import { Test } from "@nestjs/testing";
import { LedgerAccountKind, LedgerOwnerType } from "@prisma/client";
import * as fc from "fast-check";
import { randomUUID } from "node:crypto";
import { applyTestEnv } from "../../../test/setup/env";
import { ConfigModule } from "../../common/config/config.module";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AccountsService } from "./accounts.service";
import { LedgerService } from "./ledger.service";

type Line = { accountId: string; amountPaise: bigint };

describe("Ledger and accounts", () => {
  let prisma: PrismaService;
  let ledger: LedgerService;
  let accounts: AccountsService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
    const mod = await Test.createTestingModule({ imports: [ConfigModule, PrismaModule], providers: [LedgerService, AccountsService] }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    ledger = mod.get(LedgerService);
    accounts = mod.get(AccountsService);
    close = () => mod.close();
  });
  afterAll(() => close());

  /** Fresh accounts per test (unique owners), so tests never touch each other's balances. */
  async function newAccounts(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const a = await prisma.$transaction((tx) => accounts.ensureSellerAccounts(tx, LedgerOwnerType.USER, randomUUID()));
      ids.push(a.AVAILABLE);
    }
    return ids;
  }
  const ref = () => ({ refType: "test", refId: randomUUID(), description: "t" });
  const post = (lines: Line[], r = ref()) => prisma.$transaction((tx) => ledger.post(tx, { ...r, lines }));

  describe("LedgerService.post", () => {
    it("posts a balanced entry and moves both balances", async () => {
      const [a, b] = await newAccounts(2);
      const res = await post([{ accountId: a, amountPaise: -500n }, { accountId: b, amountPaise: 500n }]);
      expect(res.duplicate).toBe(false);
      expect(await ledger.balance(a)).toBe(-500n);
      expect(await ledger.balance(b)).toBe(500n);
      expect(await prisma.ledgerLine.count({ where: { entryId: res.entryId } })).toBe(2);
    });

    it("rejects an unbalanced entry with LEDGER_UNBALANCED and writes nothing", async () => {
      const [a, b] = await newAccounts(2);
      const r = ref();
      await expect(post([{ accountId: a, amountPaise: -500n }, { accountId: b, amountPaise: 499n }], r)).rejects.toMatchObject({ code: "LEDGER_UNBALANCED" });
      expect(await prisma.journalEntry.count({ where: { refId: r.refId } })).toBe(0);
      expect(await ledger.balance(a)).toBe(0n);
    });

    it("rejects empty lines", async () => {
      await expect(post([])).rejects.toMatchObject({ code: "LEDGER_EMPTY" });
    });

    it("rejects a closed account with LEDGER_ACCOUNT_CLOSED and applies nothing", async () => {
      const [a, b] = await newAccounts(2);
      await prisma.ledgerAccount.update({ where: { id: b }, data: { closedAt: new Date() } });
      const r = ref();
      await expect(post([{ accountId: a, amountPaise: -1n }, { accountId: b, amountPaise: 1n }], r)).rejects.toMatchObject({ code: "LEDGER_ACCOUNT_CLOSED" });
      expect(await ledger.balance(a)).toBe(0n);
      expect(await prisma.journalEntry.count({ where: { refId: r.refId } })).toBe(0);
    });

    it("rejects an unknown account", async () => {
      const [a] = await newAccounts(1);
      await expect(post([{ accountId: a, amountPaise: -1n }, { accountId: randomUUID(), amountPaise: 1n }])).rejects.toMatchObject({ code: "LEDGER_ACCOUNT_NOT_FOUND" });
    });

    it("rolls everything back with the caller's transaction", async () => {
      const [a, b] = await newAccounts(2);
      const r = ref();
      await expect(
        prisma.$transaction(async (tx) => {
          await ledger.post(tx, { ...r, lines: [{ accountId: a, amountPaise: -9n }, { accountId: b, amountPaise: 9n }] });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await ledger.balance(a)).toBe(0n);
      expect(await prisma.journalEntry.count({ where: { refId: r.refId } })).toBe(0);
    });

    it("posting the same (refType, refId, description) twice yields one entry; the second is a duplicate and changes nothing", async () => {
      const [a, b] = await newAccounts(2);
      const r = ref();
      const lines = [{ accountId: a, amountPaise: -700n }, { accountId: b, amountPaise: 700n }];
      const first = await post(lines, r);
      const second = await post(lines, r);
      expect(first.duplicate).toBe(false);
      expect(second).toEqual({ entryId: first.entryId, duplicate: true });
      expect(await prisma.journalEntry.count({ where: { refId: r.refId } })).toBe(1);
      expect(await prisma.ledgerLine.count({ where: { entryId: first.entryId } })).toBe(2);
      expect(await ledger.balance(b)).toBe(700n);
      // A different description on the same ref is a different entry.
      expect((await post(lines, { ...r, description: "other" })).duplicate).toBe(false);
      expect(await ledger.balance(b)).toBe(1400n);
    });

    it("concurrent posts of the same key apply exactly once", async () => {
      const [a, b] = await newAccounts(2);
      const r = ref();
      const results = await Promise.all(Array.from({ length: 10 }, () => post([{ accountId: a, amountPaise: -50n }, { accountId: b, amountPaise: 50n }], r)));
      expect(results.filter((x) => !x.duplicate)).toHaveLength(1);
      expect(new Set(results.map((x) => x.entryId)).size).toBe(1);
      expect(await ledger.balance(b)).toBe(50n);
      expect(await ledger.balance(a)).toBe(-50n);
    });

    it("20 concurrent posts touching the same two accounts, listed in opposite orders: exact balances, no deadlock", async () => {
      const [a, b] = await newAccounts(2);
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          i % 2 === 0
            ? post([{ accountId: a, amountPaise: -10n }, { accountId: b, amountPaise: 10n }])
            : post([{ accountId: b, amountPaise: 3n }, { accountId: a, amountPaise: -3n }]),
        ),
      );
      // 10 posts moved 10 and 10 posts moved 3.
      expect(await ledger.balance(a)).toBe(-130n);
      expect(await ledger.balance(b)).toBe(130n);
    });

    it("balances equal the sum of lines after 200 random balanced entries (property, 20 runs of 10 entries)", async () => {
      const pool = await newAccounts(5);
      const entry = fc.array(fc.tuple(fc.integer({ min: 0, max: 4 }), fc.bigInt({ min: -100000n, max: 100000n })), { minLength: 1, maxLength: 4 }).map((legs) => {
        const lines: Line[] = legs.map(([i, amt]) => ({ accountId: pool[i], amountPaise: amt }));
        const sum = lines.reduce((s, l) => s + l.amountPaise, 0n);
        lines.push({ accountId: pool[0], amountPaise: -sum }); // balances the entry
        return lines;
      });
      let posted = 0;
      await fc.assert(
        fc.asyncProperty(fc.array(entry, { minLength: 10, maxLength: 10 }), async (entries) => {
          for (const lines of entries) {
            await post(lines);
            posted++;
          }
          for (const id of pool) {
            const agg = await prisma.ledgerLine.aggregate({ where: { accountId: id }, _sum: { amountPaise: true } });
            expect(await ledger.balance(id)).toBe(agg._sum.amountPaise ?? 0n);
          }
        }),
        { numRuns: 20 },
      );
      expect(posted).toBe(200);
      // The whole ledger nets to zero.
      const total = await prisma.ledgerLine.aggregate({ where: { accountId: { in: pool } }, _sum: { amountPaise: true } });
      expect(total._sum.amountPaise).toBe(0n);
    });
  });

  describe("LedgerService.balancesFor", () => {
    it("returns every kind, zero where an account has no activity or does not exist", async () => {
      const ownerId = randomUUID();
      const ids = await prisma.$transaction((tx) => accounts.ensureSellerAccounts(tx, LedgerOwnerType.ORG, ownerId));
      const [other] = await newAccounts(1);
      await post([{ accountId: other, amountPaise: -900n }, { accountId: ids.PENDING, amountPaise: 900n }]);
      const balances = await ledger.balancesFor(LedgerOwnerType.ORG, ownerId);
      expect(balances.PENDING).toBe(900n);
      expect(balances.AVAILABLE).toBe(0n);
      expect(balances.PAYOUT_LOCKED).toBe(0n);
      expect(balances.REFUNDS).toBe(0n);
      expect(Object.keys(balances).sort()).toEqual(Object.values(LedgerAccountKind).sort());
    });
  });

  describe("AccountsService", () => {
    it("ensureSellerAccounts is idempotent, also under concurrency, and creates balance rows", async () => {
      const ownerId = randomUUID();
      const results = await Promise.all(Array.from({ length: 8 }, () => prisma.$transaction((tx) => accounts.ensureSellerAccounts(tx, LedgerOwnerType.USER, ownerId))));
      expect(new Set(results.map((r) => r.AVAILABLE)).size).toBe(1);
      expect(await prisma.ledgerAccount.count({ where: { ownerType: "USER", ownerId } })).toBe(3);
      expect(await prisma.accountBalance.count({ where: { account: { ownerType: "USER", ownerId } } })).toBe(3);
    });

    it("platformAccount is created once per kind (NULLS NOT DISTINCT), also under concurrency", async () => {
      const ids = await Promise.all(Array.from({ length: 8 }, () => accounts.platformAccount("TAX_PAYABLE")));
      expect(new Set(ids).size).toBe(1);
      expect(await prisma.ledgerAccount.count({ where: { ownerType: "PLATFORM", ownerId: null, kind: "TAX_PAYABLE" } })).toBe(1);
      await expect(prisma.ledgerAccount.create({ data: { ownerType: "PLATFORM", ownerId: null, kind: "TAX_PAYABLE" } })).rejects.toMatchObject({ code: "P2002" });
    });

    it("platformAccount rejects seller kinds", async () => {
      await expect(accounts.platformAccount("AVAILABLE" as never)).rejects.toBeInstanceOf(Error);
    });

    it("the seed creates every platform account", async () => {
      for (const kind of ["GATEWAY_CLEARING", "PLATFORM_REVENUE", "TAX_PAYABLE", "REFUNDS"] as const) {
        expect(await prisma.ledgerAccount.count({ where: { ownerType: "PLATFORM", ownerId: null, kind } })).toBe(1);
      }
    });
  });
});
