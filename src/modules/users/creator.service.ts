import { Injectable } from "@nestjs/common";
import { OutboxService } from "../../common/outbox/outbox.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { PermissionService } from "../rbac/permission.service";
import { RolesService } from "../rbac/roles.service";
import { ProfilesService } from "./profiles.service";

export const CREATOR_ROLE_KEY = "creator";

@Injectable()
export class CreatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
    private readonly roles: RolesService,
    private readonly permissions: PermissionService,
    private readonly outbox: OutboxService,
  ) {}

  /** Idempotent. The flag, the role grant and the event commit together; only the call that flips the flag emits the event. */
  async becomeCreator(userId: string): Promise<{ isCreator: true; changed: boolean }> {
    await this.profiles.ensure(userId);
    const changed = await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.profile.updateMany({ where: { userId, isCreator: false }, data: { isCreator: true } });
      // Always granted (a no-op when already held), so a half-onboarded account is repaired by calling this again.
      await this.roles.grantSystem(userId, CREATOR_ROLE_KEY, tx);
      if (flipped.count === 1) {
        await this.outbox.enqueue(tx, { type: "user.became_creator", userId });
        await this.outbox.enqueue(tx, { type: "rbac.permissions_changed", userIds: [userId] });
      }
      return flipped.count === 1;
    });
    await this.permissions.invalidateUser(userId);
    return { isCreator: true, changed };
  }
}
