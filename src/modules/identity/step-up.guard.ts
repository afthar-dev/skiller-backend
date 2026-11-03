import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import type { AuthUser } from "../../common/auth/auth-user";
import { AppError } from "../../common/errors/app-error";
import { StepUpService } from "./step-up.service";

/** Runs after the global AuthGuard, so `req.user` is set. Use through @RequireStepUp(). */
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(private readonly stepUp: StepUpService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<Request & { user?: AuthUser }>().user;
    if (!user || !(await this.stepUp.isActive(user.sessionId))) {
      throw new AppError("STEP_UP_REQUIRED", 403, "Verify your email code to continue");
    }
    return true;
  }
}
