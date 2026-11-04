import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination } from "../../common/openapi/zod-schema";
import { RateLimit } from "../../common/redis/rate-limit.decorator";
import { CertificatesService } from "./certificates.service";

@ApiTags("Certificates")
@Controller()
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @AuthenticatedOnly()
  @Get("me/certificates")
  @ApiOperation({ summary: "My certificates, newest first (revoked ones are listed with status REVOKED)" })
  @ApiPagination()
  mine(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.certificates.mine(user.id, parsePage(query));
  }

  @Public()
  @Get("certificates/:code")
  @RateLimit({ key: (req) => `certificate:verify:${req.ip}`, limit: 60, windowSec: 60 })
  @ApiOperation({ summary: "Verify a certificate by its code: learner name, course, issuer, date and VALID / REVOKED. No account needed, no personal data beyond the name; 60 per minute per IP" })
  verify(@Param("code") code: string) {
    return this.certificates.verify(code);
  }

  @AuthenticatedOnly()
  @Get("certificates/:code/download")
  @ApiOperation({ summary: "A 5-minute link to the certificate PDF; only its owner (404 for anyone else, 410 once revoked)" })
  download(@CurrentUser() user: AuthUser, @Param("code") code: string) {
    return this.certificates.download(user.id, code);
  }
}
