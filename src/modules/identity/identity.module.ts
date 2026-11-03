import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { AuthService } from "./auth.service";
import { MEMBER_ROLE_GRANTER, NoopMemberRoleGranter } from "./member-role-granter";
import { MeController } from "./me.controller";
import { OtpService } from "./otp.service";
import { SessionService } from "./session.service";
import { TokenService } from "./token.service";
import { UserStatusCache } from "./user-status.cache";

@Module({
  controllers: [AuthController, MeController],
  providers: [
    OtpService,
    TokenService,
    SessionService,
    UserStatusCache,
    AuthService,
    { provide: MEMBER_ROLE_GRANTER, useClass: NoopMemberRoleGranter },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [OtpService, TokenService, SessionService, UserStatusCache, MEMBER_ROLE_GRANTER],
})
export class IdentityModule {}
