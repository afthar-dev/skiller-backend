/** One number a module reports for one IST day. Money is integer paise (`*_paise` keys); everything else is a count or a level. */
export interface MetricPoint {
  key: string;
  value: bigint;
}

/**
 * A module's contribution to the daily rollup: the numbers for one IST calendar day ("YYYY-MM-DD"), read from its own tables only.
 * The analytics module collects every provider, stores the points in `daily_metrics` and serves the dashboards from there; it never reads
 * another module's tables. A provider must be deterministic for a past day (the rollup may be re-run) and return every key it owns, zero
 * included, so a re-run overwrites stale values instead of leaving them.
 */
export interface MetricsProvider {
  readonly module: string;
  collect(day: string): Promise<MetricPoint[]>;
}
