export const MAX_HASHTAGS = 10;
/** A tag is 1-50 letters, marks (Indic vowel signs are marks), digits or underscores; a longer run is not a tag at all. */
const HASHTAG = /(?<![\p{L}\p{M}\p{N}_#])#([\p{L}\p{M}\p{N}_]{1,50})(?![\p{L}\p{M}\p{N}_])/gu;

/** Tags of a (sanitised) caption: lower-case NFC, no duplicates, in order of appearance, at most MAX_HASHTAGS (the rest are ignored, not an error). */
export function extractHashtags(caption: string): string[] {
  const tags: string[] = [];
  for (const match of caption.normalize("NFC").matchAll(HASHTAG)) {
    const tag = match[1].toLowerCase().normalize("NFC");
    if (!tags.includes(tag)) tags.push(tag);
    if (tags.length === MAX_HASHTAGS) break;
  }
  return tags;
}
