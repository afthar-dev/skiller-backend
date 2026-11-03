import { Controller, Get } from "@nestjs/common";
import type { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";

// Stub: Task 11 replaces this with the real profile endpoint.
@Controller("me")
export class MeController {
  @Get()
  me(@CurrentUser() user: AuthUser) {
    return { id: user.id };
  }
}
