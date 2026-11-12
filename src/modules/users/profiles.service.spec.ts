import type { PrismaService } from "../../common/prisma/prisma.service";
import type { OutboxService } from "../../common/outbox/outbox.service";
import type { AccountService, UserStatusCache } from "../identity";
import type { MediaService } from "../media";
import { ProfilesService } from "./profiles.service";

describe("ProfilesService module boundary", () => {
  it("looks the email up through AccountService, never the users table", async () => {
    const created = { userId: "u1", handle: "abc1234", displayName: "abc" };
    // No `user` delegate on purpose: touching prisma.user would throw.
    const prisma = {
      profile: { findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(created), createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    } as unknown as PrismaService;
    const accounts = { findEmail: jest.fn().mockResolvedValue("abc@example.com") } as unknown as AccountService;

    const profile = await new ProfilesService(prisma, accounts, { enqueue: jest.fn() } as unknown as OutboxService, {} as UserStatusCache, { publicUrls: jest.fn().mockResolvedValue(new Map()) } as unknown as MediaService).ensure("u1");
    expect(profile).toBe(created);
    expect(accounts.findEmail).toHaveBeenCalledWith("u1");
  });
});

describe("ProfilesService.update events", () => {
  const row = (displayName: string) => ({ userId: "u1", handle: "h", displayName, headline: null, about: null, avatarAssetId: null, bannerAssetId: null, location: null, links: [], followersCount: 0, followingCount: 0, isCreator: false, verifiedAt: null, updatedAt: new Date() });
  const setup = (before: string) => {
    const enqueue = jest.fn();
    const tx = {
      profile: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(row(before)),
        update: jest.fn().mockImplementation(({ data }: { data: { displayName?: string } }) => row(data.displayName ?? before)),
      },
    };
    const prisma = { profile: { findUnique: jest.fn().mockResolvedValue({ userId: "u1" }) }, $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaService;
    return { service: new ProfilesService(prisma, {} as AccountService, { enqueue } as unknown as OutboxService, {} as UserStatusCache, { publicUrls: jest.fn().mockResolvedValue(new Map()) } as unknown as MediaService), enqueue, tx };
  };

  it("announces a changed display name in the transaction of the change, so courses can re-index", async () => {
    const { service, enqueue, tx } = setup("Old Name");
    await service.update("u1", { displayName: "New Name" });
    expect(enqueue).toHaveBeenCalledWith(tx, { type: "user.profile_updated", userId: "u1" });
  });

  it("says nothing when the name did not change", async () => {
    const { service, enqueue } = setup("Same");
    await service.update("u1", { displayName: "Same" });
    await service.update("u1", { headline: "Hi" });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
