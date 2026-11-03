import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import { applyTestEnv } from "../../../test/setup/env";
import { ConfigModule } from "../../common/config/config.module";
import { EventBus } from "../../common/outbox/event-bus";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AccountsService } from "./accounts.service";
import { WalletEventHandlers } from "./wallet-events.handler";

describe("WalletEventHandlers", () => {
  let prisma: PrismaService;
  let bus: EventBus;
  let close: () => Promise<void>;

  beforeAll(async () => {
    applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
    const mod = await Test.createTestingModule({ imports: [ConfigModule, PrismaModule], providers: [EventBus, AccountsService, WalletEventHandlers] }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    bus = mod.get(EventBus);
    close = () => mod.close();
  });
  afterAll(() => close());

  it("user.became_creator creates the user's three seller accounts, once, however often it is delivered", async () => {
    const userId = randomUUID();
    await Promise.all([bus.dispatch({ type: "user.became_creator", userId }), bus.dispatch({ type: "user.became_creator", userId })]);
    await bus.dispatch({ type: "user.became_creator", userId });
    const rows = await prisma.ledgerAccount.findMany({ where: { ownerType: "USER", ownerId: userId } });
    expect(rows.map((r) => r.kind).sort()).toEqual(["AVAILABLE", "PAYOUT_LOCKED", "PENDING"]);
    expect(await prisma.accountBalance.count({ where: { accountId: { in: rows.map((r) => r.id) } } })).toBe(3);
  });

  it("org.created creates the organization's three seller accounts, idempotently", async () => {
    const orgId = randomUUID();
    await bus.dispatch({ type: "org.created", orgId, ownerId: randomUUID() });
    await bus.dispatch({ type: "org.created", orgId, ownerId: randomUUID() });
    const rows = await prisma.ledgerAccount.findMany({ where: { ownerType: "ORG", ownerId: orgId } });
    expect(rows.map((r) => r.kind).sort()).toEqual(["AVAILABLE", "PAYOUT_LOCKED", "PENDING"]);
  });
});
