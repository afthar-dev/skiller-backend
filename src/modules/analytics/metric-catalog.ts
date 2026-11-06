export type MetricUnit = "count" | "paise";
/** `sum`: the range total adds the days up. `latest`: a level or a distinct count that cannot be added across days, so the range shows the last day that has a value. */
export type MetricAggregation = "sum" | "latest";

export interface MetricDef {
  key: string;
  label: string;
  group: "users" | "sales" | "learning" | "reels" | "gigs" | "campaigns" | "moderation";
  unit: MetricUnit;
  aggregation: MetricAggregation;
  /** A level taken when the rollup ran (cannot be reconstructed for a past day), so a rebuild of an older day leaves it alone. */
  snapshot?: true;
  /** True for numbers that are estimates (HyperLogLog). */
  approximate?: boolean;
}

/** Every number the dashboards know. The modules' providers (and the activity rollup) fill these keys; the API accepts nothing else. */
export const METRIC_CATALOG: readonly MetricDef[] = [
  { key: "signups", label: "New accounts", group: "users", unit: "count", aggregation: "sum" },
  { key: "creators_new", label: "New creators", group: "users", unit: "count", aggregation: "sum" },
  { key: "dau", label: "Daily active members", group: "users", unit: "count", aggregation: "latest", approximate: true },
  { key: "wau", label: "Weekly active members (7 days to that day)", group: "users", unit: "count", aggregation: "latest", approximate: true },
  { key: "mau", label: "Monthly active members (30 days to that day)", group: "users", unit: "count", aggregation: "latest", approximate: true },
  { key: "orders_paid", label: "Orders paid", group: "sales", unit: "count", aggregation: "sum" },
  { key: "gmv_paise", label: "GMV", group: "sales", unit: "paise", aggregation: "sum" },
  { key: "platform_revenue_paise", label: "Platform revenue (ledger)", group: "sales", unit: "paise", aggregation: "sum" },
  { key: "refunds_paise", label: "Refunds processed", group: "sales", unit: "paise", aggregation: "sum" },
  { key: "refunds_count", label: "Refunds processed (count)", group: "sales", unit: "count", aggregation: "sum" },
  { key: "payouts_paid_paise", label: "Payouts paid", group: "sales", unit: "paise", aggregation: "sum" },
  { key: "active_paid_subscribers", label: "Active paid subscribers", group: "sales", unit: "count", aggregation: "latest", snapshot: true },
  { key: "sellers_first_sale", label: "Sellers making their first sale", group: "sales", unit: "count", aggregation: "sum" },
  { key: "enrolments", label: "Course enrolments", group: "learning", unit: "count", aggregation: "sum" },
  { key: "course_completions", label: "Course completions", group: "learning", unit: "count", aggregation: "sum" },
  { key: "certificates_issued", label: "Certificates issued", group: "learning", unit: "count", aggregation: "sum" },
  { key: "first_course_published", label: "Owners publishing their first course", group: "learning", unit: "count", aggregation: "sum" },
  { key: "reels_posted", label: "Reels posted", group: "reels", unit: "count", aggregation: "sum" },
  { key: "reel_views", label: "Reel views", group: "reels", unit: "count", aggregation: "sum" },
  { key: "reel_comments", label: "New reel comments", group: "reels", unit: "count", aggregation: "sum" },
  { key: "gigs_published", label: "Gigs published", group: "gigs", unit: "count", aggregation: "sum" },
  { key: "first_gig_published", label: "Sellers publishing their first gig", group: "gigs", unit: "count", aggregation: "sum" },
  { key: "gigs_active", label: "Active gigs", group: "gigs", unit: "count", aggregation: "latest", snapshot: true },
  { key: "gig_inquiries", label: "Gig inquiries (new conversations from a gig)", group: "gigs", unit: "count", aggregation: "sum" },
  { key: "messages_sent", label: "Messages sent", group: "gigs", unit: "count", aggregation: "sum" },
  { key: "campaign_sends", label: "Campaign emails sent", group: "campaigns", unit: "count", aggregation: "sum" },
  { key: "campaign_opens", label: "Campaign emails opened", group: "campaigns", unit: "count", aggregation: "sum" },
  { key: "campaign_clicks", label: "Campaign emails clicked", group: "campaigns", unit: "count", aggregation: "sum" },
  { key: "reports_opened", label: "Reports opened", group: "moderation", unit: "count", aggregation: "sum" },
  { key: "reports_upheld", label: "Reports upheld", group: "moderation", unit: "count", aggregation: "sum" },
];

export const METRIC_KEYS: readonly string[] = METRIC_CATALOG.map((m) => m.key);
export const metricDef = (key: string): MetricDef | undefined => METRIC_CATALOG.find((m) => m.key === key);

/** Signup -> creator -> first published course or gig -> first sale. Counts for the range, never users: the stages are not a cohort. */
export const FUNNEL_STAGES: ReadonlyArray<{ key: string; label: string; from: readonly string[] }> = [
  { key: "signups", label: "Signed up", from: ["signups"] },
  { key: "creators", label: "Became a creator", from: ["creators_new"] },
  { key: "first_listing", label: "Published a first course or gig", from: ["first_course_published", "first_gig_published"] },
  { key: "first_sale", label: "Made a first sale", from: ["sellers_first_sale"] },
];
