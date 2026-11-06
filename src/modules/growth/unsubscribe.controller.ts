import { Body, Controller, Get, Post, Query, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiProduces, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { Public } from "../../common/auth/public.decorator";
import { AppError } from "../../common/errors/app-error";
import { confirmPage, donePage, invalidPage } from "./unsubscribe-page";
import { UnsubscribeService } from "./unsubscribe.service";

const html = (res: Response, status: number, body: string) => {
  res
    .status(status)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    })
    .send(body);
};
const isInvalidLink = (err: unknown) => err instanceof AppError && err.code === "UNSUBSCRIBE_TOKEN_INVALID";

/**
 * The link in every promotional mail. Public by design: the signed token is the credential.
 * GET only shows a page with a button, so a mail scanner or link preview that follows the link changes nothing. POST does it: the button posts here and gets a
 * "done" page; a mailbox provider's RFC 8058 one-click request (`List-Unsubscribe=One-Click` in a form body) gets a bare 200 JSON.
 */
@ApiTags("Unsubscribe")
@Controller("unsubscribe")
export class UnsubscribeController {
  constructor(private readonly unsubscribe: UnsubscribeService) {}

  @Public()
  @Get()
  @ApiProduces("text/html")
  @ApiQuery({ name: "t", required: true, description: "The signed token from the email's unsubscribe link" })
  @ApiOperation({ summary: "The page behind the Unsubscribe link: a button that posts back here. Changes nothing itself and never shows the address. 400 (HTML) for a forged or damaged link" })
  async show(@Query("t") token: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      await this.unsubscribe.open(token, req.ip ?? "unknown", "view");
      html(res, 200, confirmPage());
    } catch (err) {
      if (!isInvalidLink(err)) throw err;
      html(res, 400, invalidPage());
    }
  }

  @Public()
  @Post()
  @ApiQuery({ name: "t", required: true })
  @ApiOperation({
    summary:
      "Unsubscribes: turns promotional email off for the member and suppresses the address. The page's button gets an HTML confirmation; the RFC 8058 one-click request (body List-Unsubscribe=One-Click) gets 200 JSON. Repeating it is harmless",
  })
  async apply(@Query("t") token: unknown, @Body() body: Record<string, unknown> | undefined, @Req() req: Request, @Res() res: Response): Promise<void> {
    const oneClick = body?.["List-Unsubscribe"] === "One-Click";
    try {
      const { userId } = await this.unsubscribe.open(token, req.ip ?? "unknown", "apply");
      const done = await this.unsubscribe.apply(userId);
      if (oneClick) res.status(200).json(done);
      else html(res, 200, donePage());
    } catch (err) {
      if (oneClick || !isInvalidLink(err)) throw err;
      html(res, 400, invalidPage());
    }
  }
}
