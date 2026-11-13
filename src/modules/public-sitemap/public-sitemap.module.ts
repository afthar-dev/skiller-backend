import { Module } from "@nestjs/common";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { SignedCursor } from "../../common/http/signed-cursor";
import { PublicSitemapController } from "./public-sitemap.controller";
import { PublicSitemapService } from "./public-sitemap.service";

/** The list of public pages search engines may index. Reads only; the visibility rules are restated in PublicSitemapService. */
@Module({
  controllers: [PublicSitemapController],
  providers: [PublicSitemapService, { provide: SignedCursor, inject: [APP_CONFIG], useFactory: (config: AppConfig) => new SignedCursor(config.jwtSecret) }],
})
export class PublicSitemapModule {}
