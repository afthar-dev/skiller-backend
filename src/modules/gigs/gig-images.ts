import { Injectable } from "@nestjs/common";
import { MediaService } from "../media";

/** Width (px) of the rendition a gig card or page uses; the image worker makes 256 and 1024 wide variants. */
const WIDTH = "1024";

/** The 1024 px rendition, else the widest one available (a small source has fewer). */
function pick(urls: Record<string, string> | undefined): string | null {
  if (!urls) return null;
  if (urls[WIDTH]) return urls[WIDTH];
  const widest = Object.keys(urls).map(Number).filter(Number.isFinite).sort((a, b) => b - a)[0];
  return widest === undefined ? null : urls[String(widest)];
}

/** Public picture URLs of gigs, looked up for a whole page at once. An asset that is missing, not ready or private has no URL. */
@Injectable()
export class GigImages {
  constructor(private readonly media: MediaService) {}

  /** Asset id to public URL, for the ids that have one. */
  async urls(assetIds: Array<string | null>): Promise<Map<string, string>> {
    const found = await this.media.publicUrls(assetIds.filter((id): id is string => Boolean(id)));
    const out = new Map<string, string>();
    for (const [id, variants] of found) {
      const url = pick(variants);
      if (url) out.set(id, url);
    }
    return out;
  }
}
