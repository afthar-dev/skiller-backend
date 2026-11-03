import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { OutboxService } from "../../common/outbox/outbox.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { MEMBER_ROLE_GRANTER, type MemberRoleGranter } from "./member-role-granter";
import { OtpService } from "./otp.service";
import { SessionMeta, SessionService } from "./session.service";
import { TokenService } from "./token.service";
import { UserStatusCache } from "./user-status.cache";

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; isNew: boolean };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly statuses: UserStatusCache,
    private readonly outbox: OutboxService,
    @Inject(MEMBER_ROLE_GRANTER) private readonly roles: MemberRoleGranter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async verifyLogin(challengeId: string, code: string, meta: SessionMeta): Promise<LoginResult> {
    // Only LOGIN challenges are accepted here; a STEP_UP challenge fails as OTP_INVALID without being consumed.
    const { email } = await this.otp.verify(challengeId, code, { purpose: "LOGIN" });
    const now = this.clock.now();

    const { user, isNew } = await this.prisma.$transaction(async (tx) => {
      // INSERT .. ON CONFLICT DO NOTHING: two first-time logins racing for one email create exactly one user.
      const created = await tx.user.createMany({ data: [{ email, emailVerifiedAt: now, createdAt: now }], skipDuplicates: true });
      const row = await tx.user.findUniqueOrThrow({ where: { email } });
      const isNew = created.count === 1;
      if (isNew) {
        await this.roles.grantMember(tx, row.id);
        await this.outbox.enqueue(tx, { type: "user.registered", userId: row.id, email });
        return { user: row, isNew };
      }
      if (row.status !== "ACTIVE") throw this.suspended();
      if (!row.emailVerifiedAt) await tx.user.update({ where: { id: row.id }, data: { emailVerifiedAt: now } });
      return { user: row, isNew };
    });

    const { session, refreshToken } = await this.sessions.create(user.id, meta);
    const accessToken = this.tokens.signAccess({ sub: user.id, sid: session.id });
    return { accessToken, refreshToken, user: { id: user.id, email: user.email, isNew } };
  }

  async refresh(refreshToken: string, meta: SessionMeta): Promise<{ accessToken: string; refreshToken: string }> {
    const rotated = await this.sessions.rotate(refreshToken, meta);
    const status = await this.statuses.get(rotated.userId);
    if (status !== "ACTIVE") throw this.suspended();
    return { accessToken: this.tokens.signAccess({ sub: rotated.userId, sid: rotated.sessionId }), refreshToken: rotated.refreshToken };
  }

  private suspended() {
    return new AppError("AUTH_ACCOUNT_SUSPENDED", 403, "Account is suspended");
  }
}
