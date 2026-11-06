import { Controller, Get, HttpCode, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Public } from "../../common/auth/public.decorator";
import { RateLimit } from "../../common/redis/rate-limit.decorator";
import { UnsubscribeService } from "./unsubscribe.service";

const limit = () => RateLimit({ key: (req) => `unsubscribe:${req.ip}`, limit: 60, windowSec: 60 });

/**
 * The link in every promotional mail. Public by design: the signed token is the credential. GET only describes (a mail scanner that follows links
 * changes nothing); POST does it, which is what mail clients send for RFC 8058 one-click (`List-Unsubscribe=One-Click` in a form body, ignored).
 */
@ApiTags("Unsubscribe")
@Controller("unsubscribe")
export class UnsubscribeController {
  constructor(private readonly unsubscribe: UnsubscribeService) {}

  @Public()
  @limit()
  @Get()
  @ApiQuery({ name: "t", required: true, description: "The signed token from the email's unsubscribe link" })
  @ApiOperation({ summary: "What an unsubscribe link is for (category, and whether it is already done); never shows the address. 400 UNSUBSCRIBE_TOKEN_INVALID for a forged or damaged link" })
  show(@Query("t") token: unknown) {
    return this.unsubscribe.describe(token);
  }

  @Public()
  @limit()
  @Post()
  @HttpCode(200)
  @ApiQuery({ name: "t", required: true })
  @ApiOperation({ summary: "One-click unsubscribe (RFC 8058): turns promotional email off for the member and suppresses the address. Repeating it is harmless" })
  apply(@Query("t") token: unknown) {
    return this.unsubscribe.apply(token);
  }
}
