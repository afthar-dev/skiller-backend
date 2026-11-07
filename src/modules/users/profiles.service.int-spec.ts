import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ConfigModule } from "../../common/config/config.module";
import { applyTestEnv } from "../../../test/setup/env";
import * as handles from "./handles";
import { OutboxService } from "../../common/outbox/outbox.service";
import { AccountService, UserStatusCache } from "../identity";
import { ProfilesService } from "./profiles.service";

describe("ProfilesService.ensure", () => {
  let prisma: PrismaService;
  let service: ProfilesService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
    const mod = await Test.createTestingModule({ imports: [ConfigModule, PrismaModule], providers: [AccountService, OutboxService, ProfilesService, { provide: UserStatusCache, useValue: {} }] }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    service = mod.get(ProfilesService);
    close = () => mod.close();
  });
  afterAll(() => close());

  const newUser = (email = `ens-${randomUUID()}@example.com`) => prisma.user.create({ data: { email } });

  it("is idempotent and safe under concurrency: one profile, one handle", async () => {
    const user = await newUser();
    const results = await Promise.all(Array.from({ length: 8 }, () => service.ensure(user.id, user.email)));
    expect(new Set(results.map((r) => r.handle)).size).toBe(1);
    expect(await prisma.profile.count({ where: { userId: user.id } })).toBe(1);
    expect((await service.ensure(user.id)).handle).toBe(results[0].handle);
  });

  it("retries with a new handle when the generated one collides", async () => {
    const holder = await newUser();
    const taken = (await service.ensure(holder.id, holder.email)).handle;
    const user = await newUser();
    const spy = jest.spyOn(handles, "generateHandle").mockReturnValueOnce(taken).mockReturnValueOnce(taken);
    try {
      const profile = await service.ensure(user.id, user.email);
      expect(profile.handle).not.toBe(taken);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });
});
