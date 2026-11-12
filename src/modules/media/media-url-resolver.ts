import { Inject, Injectable } from "@nestjs/common";
import type { MediaAsset } from "@prisma/client";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { PrismaService } from "../../common/prisma/prisma.service";
import { assetPrefix } from "./media.rules";

/** Public URLs (see MediaAssetDto.urls) of a READY public asset: image variants (`256`, `1024`) or `hls` + `poster`. Null otherwise. */
export function publicUrlsOf(a: MediaAsset, base: string): Record<string, string> | null {
  if (a.bucket !== "PUBLIC" || a.status !== "READY") return null;
  const prefix = assetPrefix(a);
  const renditions = a.renditions as Record<string, unknown> | unknown[] | null;
  if (a.purpose === "REEL" || a.purpose === "COURSE_PROMO") {
    const out: Record<string, string> = { hls: `${base}/${prefix}/hls/index.m3u8` };
    if (a.posterKey) out.poster = `${base}/${a.posterKey}`;
    return out;
  }
  if (renditions && !Array.isArray(renditions)) {
    return Object.fromEntries(Object.entries(renditions).map(([size, key]) => [size, `${base}/${String(key)}`]));
  }
  return null;
}

/**
 * Read-only lookup of public asset URLs. Depends only on the database and config (never on users), so modules that
 * build responses (profiles) can use it without a provider cycle with MediaService.
 */
@Injectable()
export class MediaUrlResolver {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Public URLs of READY public assets, by id; ids that are unknown, not ready or private are absent. */
  async publicUrls(assetIds: string[]): Promise<Map<string, Record<string, string>>> {
    if (assetIds.length === 0) return new Map();
    const rows = await this.prisma.mediaAsset.findMany({ where: { id: { in: [...new Set(assetIds)] } } });
    const out = new Map<string, Record<string, string>>();
    for (const row of rows) {
      const urls = publicUrlsOf(row, this.config.r2.publicBaseUrl);
      if (urls) out.set(row.id, urls);
    }
    return out;
  }
}
