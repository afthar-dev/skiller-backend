import { Injectable } from "@nestjs/common";
import type { UserStatus } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";

export interface Account {
  id: string;
  email: string;
  status: UserStatus;
}

/** Read access to the identity-owned user row for other modules. */
@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<Account> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, status: true } });
    if (!user) throw new AppError("AUTH_TOKEN_INVALID", 401, "Invalid access token");
    return user;
  }
}
