import { Injectable } from "@nestjs/common";
import { MediaService } from "../media";

/** Width (px) of the rendition a 16:9 course card uses; the image worker makes 256 and 1024 wide variants, 1024 stays sharp on a retina card. */
const CARD_WIDTH = 1024;

/** The rendition for a card: the one at CARD_WIDTH, else the widest available (a small source has fewer). */
export function cardVariant(urls: Record<string, string>): string | null {
  if (urls[CARD_WIDTH]) return urls[CARD_WIDTH];
  const widest = Object.keys(urls)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  return widest === undefined ? null : urls[String(widest)];
}

/** Public thumbnail URLs of courses, looked up for a whole page at once. */
@Injectable()
export class CourseThumbnails {
  constructor(private readonly media: MediaService) {}

  /** Each item with `thumbnailUrl` added: null when the course has no thumbnail or the asset is missing, not ready or private. One query for the page. */
  async withUrls<T extends { thumbnailAssetId: string | null }>(items: T[]): Promise<(T & { thumbnailUrl: string | null })[]> {
    const ids = items.flatMap((i) => (i.thumbnailAssetId ? [i.thumbnailAssetId] : []));
    const urls = await this.media.publicUrls(ids);
    return items.map((i) => ({ ...i, thumbnailUrl: i.thumbnailAssetId ? cardVariant(urls.get(i.thumbnailAssetId) ?? {}) : null }));
  }

  async withUrl<T extends { thumbnailAssetId: string | null }>(item: T): Promise<T & { thumbnailUrl: string | null }> {
    return (await this.withUrls([item]))[0];
  }
}
