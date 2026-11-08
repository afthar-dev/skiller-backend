import { Body, Controller, Get, Header, HttpCode, Param, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiJsonResponse } from "../../common/openapi/responses";
import { ApiPagination, ApiZodBody } from "../../common/openapi/zod-schema";
import { RateLimit } from "../../common/redis/rate-limit.decorator";
import { z } from "zod";
import { CertificatesService } from "./certificates.service";
import { certificateDownloadSchema, certificatePageSchema, certificateSchema, publicCertificateSchema } from "./course-responses";

const nameSchema = z.object({ name: z.string().min(1).max(200) }).strict();

@ApiTags("Certificates")
@Controller()
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @AuthenticatedOnly()
  @Get("me/certificates")
  @ApiOperation({ summary: "My certificates, newest first (revoked ones are listed with status REVOKED)" })
  @ApiPagination()
  @ApiJsonResponse(200, "A page of certificates; nextCursor is null on the last page.", certificatePageSchema)
  mine(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.certificates.mine(user.id, parsePage(query));
  }

  @AuthenticatedOnly()
  @Post("me/certificates/:id/name")
  @HttpCode(200)
  @ApiOperation({ summary: "Name a certificate that is waiting for it (the learner never set a display name), once. Generates the PDF and makes the certificate valid and public" })
  @ApiJsonResponse(200, "The certificate, now VALID.", certificateSchema)
  @ApiZodBody(nameSchema)
  setName(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.certificates.setName(user.id, id, nameSchema.parse(body).name);
  }

  @Public()
  @Get("certificates/:code")
  @Header("Cache-Control", "no-store")
  @RateLimit({ key: (req) => `certificate:verify:${req.ip}`, limit: 60, windowSec: 60 })
  @ApiOperation({ summary: "Verify a certificate by its code: learner name, course, issuer, date and VALID / REVOKED. No account needed, no personal data beyond the name; 60 per minute per IP" })
  @ApiJsonResponse(200, "What the code proves; no personal data beyond the learner's name.", publicCertificateSchema)
  verify(@Param("code") code: string) {
    return this.certificates.verify(code);
  }

  @AuthenticatedOnly()
  @Get("certificates/:code/download")
  @ApiOperation({ summary: "A 5-minute link to the certificate PDF; only its owner (404 for anyone else, 410 once revoked)" })
  @ApiJsonResponse(200, "A short-lived link to the PDF.", certificateDownloadSchema)
  download(@CurrentUser() user: AuthUser, @Param("code") code: string) {
    return this.certificates.download(user.id, code);
  }
}
