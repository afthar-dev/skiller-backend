/** Rounds of fetching before a page is returned short: a run of hidden reels must not make one request loop for long. */
const MAX_ROUNDS = 5;

export interface VisiblePageOptions<T, P> {
  limit: number;
  /** Where to continue after (null = from the start). */
  start: P | null;
  /** Up to `take` rows after `after`, in list order. */
  fetch(after: P | null, take: number): Promise<T[]>;
  posOf(row: T): P;
  idOf(row: T): string;
  /** Of these reel ids, the ones the viewer may see (ReelVisibility.filterVisible). */
  visible(ids: string[]): Promise<string[]>;
}

/**
 * One page of a keyset list through the visibility seam. Rows the viewer may not see are skipped and the page is topped up from the rows
 * after them, so a page is full unless the list ends. `next` is where the following page continues (null at the end of the list); it sits
 * after the last row looked at, so a skipped row is never looked at twice and a seen one never again.
 */
export async function collectVisible<T, P>(o: VisiblePageOptions<T, P>): Promise<{ items: T[]; next: P | null }> {
  const items: T[] = [];
  let after = o.start;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const need = o.limit - items.length;
    const rows = await o.fetch(after, need + 1);
    const looked = rows.slice(0, need);
    const ok = new Set(await o.visible(looked.map((r) => o.idOf(r))));
    for (const row of looked) if (ok.has(o.idOf(row))) items.push(row);
    if (looked.length > 0) after = o.posOf(looked[looked.length - 1]);
    if (rows.length <= need) return { items, next: null };
    if (items.length >= o.limit) return { items, next: after };
  }
  return { items, next: after };
}
