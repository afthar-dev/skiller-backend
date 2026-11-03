import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

export interface MemberRoleGranter {
  /** Called inside the transaction that creates the user. */
  grantMember(tx: Prisma.TransactionClient, userId: string): Promise<void>;
}

export const MEMBER_ROLE_GRANTER = Symbol("MEMBER_ROLE_GRANTER");

/** Default binding until the roles module (Task 10) rebinds MEMBER_ROLE_GRANTER. */
@Injectable()
export class NoopMemberRoleGranter implements MemberRoleGranter {
  async grantMember(): Promise<void> {}
}
