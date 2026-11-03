import type { PrismaService } from "../../common/prisma/prisma.service";
import type { AccountService } from "../identity";
import { ProfilesService } from "./profiles.service";

describe("ProfilesService module boundary", () => {
  it("looks the email up through AccountService, never the users table", async () => {
    const created = { userId: "u1", handle: "abc1234", displayName: "abc" };
    // No `user` delegate on purpose: touching prisma.user would throw.
    const prisma = {
      profile: { findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(created), createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    } as unknown as PrismaService;
    const accounts = { findEmail: jest.fn().mockResolvedValue("abc@example.com") } as unknown as AccountService;

    const profile = await new ProfilesService(prisma, accounts).ensure("u1");
    expect(profile).toBe(created);
    expect(accounts.findEmail).toHaveBeenCalledWith("u1");
  });
});
