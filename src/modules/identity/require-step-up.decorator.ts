import { applyDecorators, UseGuards } from "@nestjs/common";
import { StepUpGuard } from "./step-up.guard";

/** Marks a route as needing a step-up verified within the last 5 minutes on the current session. */
export const RequireStepUp = () => applyDecorators(UseGuards(StepUpGuard));
