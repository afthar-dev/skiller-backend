import { Injectable } from "@nestjs/common";

export interface FilterableNotification {
  id: string;
  type: string;
  data: unknown;
}

/**
 * A module that owns the things notifications point at (a reel, a comment) says which of a user's notifications must no longer be shown: the thing was hidden or
 * removed by moderation, or its author is blocked. Read-time, so it also covers notifications written before the change.
 */
export interface NotificationFilter {
  /** The notification types this filter can hide; every other type is shown without asking (and counted with one SQL count). */
  readonly types: readonly string[];
  /** Ids of the notifications (among `rows`, all the user's) to leave out. */
  hidden(userId: string, rows: FilterableNotification[]): Promise<Set<string>>;
}

@Injectable()
export class NotificationFilters {
  private readonly filters: NotificationFilter[] = [];

  register(filter: NotificationFilter): void {
    this.filters.push(filter);
  }

  /** Whether any filter may hide this type. */
  mayHide(type: string): boolean {
    return this.filters.some((f) => f.types.includes(type));
  }

  /** Types some filter may hide. */
  filteredTypes(): string[] {
    return [...new Set(this.filters.flatMap((f) => f.types))];
  }

  async hidden(userId: string, rows: FilterableNotification[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (rows.length === 0) return out;
    for (const filter of this.filters) for (const id of await filter.hidden(userId, rows)) out.add(id);
    return out;
  }
}
