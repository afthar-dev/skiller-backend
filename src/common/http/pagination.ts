export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface PageQuery {
  cursor?: string;
  limit: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function parsePage(query: { cursor?: unknown; limit?: unknown }): PageQuery {
  const raw = Number(query.limit);
  const limit = Number.isFinite(raw) && query.limit !== undefined ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(raw))) : DEFAULT_LIMIT;
  const cursor = typeof query.cursor === "string" && query.cursor.length > 0 ? query.cursor : undefined;
  return { cursor, limit };
}

// Callers fetch `limit + 1` rows; the extra row only signals that another page exists.
export function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
}
