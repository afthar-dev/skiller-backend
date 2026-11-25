import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ConfigModule } from "../../common/config/config.module";
import { OutboxService } from "../../common/outbox/outbox.service";
import { applyTestEnv } from "../../../test/setup/env";
import { AccountService, UserStatusCache } from "../identity";
import { MediaUrlResolver } from "../media";
import { UserBlocks } from "../moderation";
import { FollowsService } from "./follows.service";
import { ProfilesService } from "./profiles.service";

describe("FollowsService concurrency (DAT-7)", () => {
  let prisma: PrismaService;
  let follows: FollowsService;
  let profiles: ProfilesService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
    const mod = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
      providers: [
        AccountService,
        OutboxService,
        ProfilesService,
        FollowsService,
        { provide: UserBlocks, useValue: { isBlockedEitherWay: async () => false } },
        { provide: UserStatusCache, useValue: { get: async () => "ACTIVE" } },
        { provide: MediaUrlResolver, useValue: { publicUrls: async () => new Map() } },
      ],
    }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    follows = mod.get(FollowsService);
    profiles = mod.get(ProfilesService);
    close = () => mod.close();
  });
  afterAll(() => close());

  const newMember = async () => {
    const user = await prisma.user.create({ data: { email: `fol-${randomUUID()}@example.com` } });
    return { id: user.id, handle: (await profiles.ensure(user.id, user.email)).handle };
  };

  it("mutual follows and unfollows never deadlock and the counters match the rows", async () => {
    const a = await newMember();
    const b = await newMember();
    for (let i = 0; i < 25; i++) {
      await Promise.all([follows.follow(a.id, b.handle), follows.follow(b.id, a.handle)]);
      await Promise.all([follows.unfollow(a.id, b.handle), follows.unfollow(b.id, a.handle)]);
    }
    await Promise.all([follows.follow(a.id, b.handle), follows.follow(b.id, a.handle)]);
    for (const m of [a, b]) {
      const p = await prisma.profile.findUniqueOrThrow({ where: { userId: m.id } });
      expect(p.followersCount).toBe(await prisma.follow.count({ where: { followeeId: m.id } }));
      expect(p.followingCount).toBe(await prisma.follow.count({ where: { followerId: m.id } }));
      expect(p.followersCount).toBe(1);
    }
  });
});
