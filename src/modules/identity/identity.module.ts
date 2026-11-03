import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { AuthService } from "./auth.service";
import { MEMBER_ROLE_GRANTER, NoopMemberRoleGranter } from "./member-role-granter";
import { MeController } from "./me.controller";
import { OtpService } from "./otp.service";
import { SessionService } from "./session.service";
import { StepUpGuard } from "./step-up.guard";
import { StepUpService } from "./step-up.service";
import { TokenService } from "./token.service";
import { UserStatusCache } from "./user-status.cache";

// Global so any module can use @RequireStepUp() (StepUpGuard resolves StepUpService in the host module).
@Global()
@Module({
  controllers: [AuthController, MeController],
  providers: [
    OtpService,
    TokenService,
    SessionService,
    UserStatusCache,
    StepUpService,
    StepUpGuard,
    AuthService,
    { provide: MEMBER_ROLE_GRANTER, useClass: NoopMemberRoleGranter },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [OtpService, TokenService, SessionService, UserStatusCache, StepUpService, StepUpGuard, MEMBER_ROLE_GRANTER],
})
export class IdentityModule {}
