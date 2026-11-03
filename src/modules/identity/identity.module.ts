import { Global, Module } from "@nestjs/common";
import { AccountService } from "./account.service";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { AuthService } from "./auth.service";
import { OtpService } from "./otp.service";
import { SessionService } from "./session.service";
import { StepUpGuard } from "./step-up.guard";
import { StepUpService } from "./step-up.service";
import { TokenService } from "./token.service";
import { UserStatusCache } from "./user-status.cache";

// Global so any module can use @RequireStepUp() (StepUpGuard resolves StepUpService in the host module).
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    OtpService,
    AccountService,
    TokenService,
    SessionService,
    UserStatusCache,
    StepUpService,
    StepUpGuard,
    AuthService,
    AuthGuard,
  ],
  exports: [AccountService, AuthGuard, OtpService, TokenService, SessionService, UserStatusCache, StepUpService, StepUpGuard],
})
export class IdentityModule {}
