import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { MemberRoleGranter } from "../identity/member-role-granter";
import { MEMBER_ROLE_KEY } from "./default-roles";
import { RolesService } from "./roles.service";

/** Sign-up grants `member` inside the user-creating transaction. */
@Injectable()
export class RbacMemberRoleGranter implements MemberRoleGranter {
  constructor(private readonly roles: RolesService) {}

  grantMember(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    return this.roles.grantSystem(userId, MEMBER_ROLE_KEY, tx);
  }
}
