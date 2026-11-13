/**
 * Response shapes of the `/v1/admin/*` routes (users, roles, moderation, content hides, categories, campaigns, analytics, settings, flags, audit, outbox,
 * payout accounts, subscriptions, plan writes). Each one is what the handler really returns; the admin contract e2e spec checks live responses against them.
 * `buildOpenApiDocument` merges `adminComponents` into `components.schemas`; routes name them with `ApiResult` / `ApiPageResult`.
 * Money-bearing admin shapes (orders, refunds, payouts, finance, plans, coupons) live in `money.ts`.
 */
import { MONEY_PATTERN } from "./money";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const str = { type: "string" } as const;
const nullableStr = { type: "string", nullable: true } as const;
const int = { type: "integer" } as const;
const bool = { type: "boolean" } as const;
const date = { type: "string", format: "date-time" } as const;
const nullableDate = { type: "string", format: "date-time", nullable: true } as const;
const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: "object", required, properties });
const strings = { type: "array", items: str } as const;
/** Free-form JSON stored as written (an audit snapshot, a setting value): any JSON value, or null. */
const anyJson = (description: string) => ({ nullable: true, description });
/** A count (JSON number) or, for a money metric, paise as a decimal string. */
const metricValue = { oneOf: [int, { type: "string", pattern: MONEY_PATTERN }], description: "A count is a JSON number; a money metric (unit `paise`) is paise as a decimal string." };
const campaignStatus = { type: "string", enum: ["DRAFT", "SCHEDULED", "SENDING", "PAUSED", "SENT", "CANCELLED"] };
const targetType = { type: "string", enum: ["REEL", "REEL_COMMENT", "COURSE_REVIEW", "COURSE_QA", "GIG_MESSAGE", "GIG"] };
const countMap = (description: string) => ({ type: "object", additionalProperties: int, description });

export const adminComponents: Record<string, unknown> = {
  AdminUserRow: obj({ id: str, email: str, status: { type: "string", enum: ["ACTIVE", "SUSPENDED", "DELETED"] }, handle: nullableStr, displayName: nullableStr, roles: { ...strings, description: "Keys of the active platform-wide roles." }, createdAt: date }),
  UserRoleGrant: obj({ id: str, userId: str, roleKey: str, orgId: nullableStr, expiresAt: nullableDate, createdAt: date }),
  AuditEntry: obj({
    id: str,
    actorId: nullableStr,
    action: str,
    targetType: str,
    targetId: str,
    before: anyJson("The state before the change, as recorded; null when there was none."),
    after: anyJson("The state after the change, as recorded; null when there was none."),
    ip: nullableStr,
    requestId: nullableStr,
    createdAt: date,
  }),
  AdminUserDetail: obj({
    user: obj({ id: str, email: str, status: { type: "string", enum: ["ACTIVE", "SUSPENDED", "DELETED"] }, emailVerifiedAt: nullableDate, createdAt: date }),
    profile: { allOf: [obj({ id: str, handle: str, displayName: str, headline: nullableStr, avatarAssetId: nullableStr, avatarUrl: nullableStr })], nullable: true },
    roles: { type: "array", items: ref("UserRoleGrant"), description: "Every grant, platform and organization, expired ones included." },
    activeSessions: int,
    recentAudit: { type: "array", items: ref("AuditEntry"), description: "The 20 newest audit rows about this user." },
  }),
  UserStatusChange: obj({ id: str, status: { type: "string", enum: ["ACTIVE", "SUSPENDED"] }, changed: { ...bool, description: "False when the user already had that status (nothing was audited)." } }),
  SessionsRevoked: obj({ id: str, revoked: { ...int, description: "How many sessions were active before." } }),
  Role: obj({ id: str, key: str, name: str, scope: { type: "string", enum: ["PLATFORM", "ORG"] }, isSystem: bool, permissionKeys: strings, createdAt: date }),
  RoleList: obj({ items: { type: "array", items: ref("Role") } }),
  Permission: obj({ key: str, description: str, module: str, orphan: { ...bool, description: "True when the key is no longer declared in code." } }),
  PermissionList: obj({ items: { type: "array", items: ref("Permission") } }),

  HiddenState: obj({ id: str, hidden: { ...bool, description: "Whether the content is hidden after the call (a review hidden by the system alone stays hidden after an unhide)." } }),
  ModerationQueueItem: obj({
    targetType,
    targetId: str,
    ownerId: nullableStr,
    reportCount: int,
    reasons: countMap("Open reports by reason (SPAM, HARASSMENT, HATE, SEXUAL, VIOLENCE, MISINFORMATION, COPYRIGHT, OTHER)."),
    firstReportedAt: date,
    lastReportedAt: date,
    autoHidden: { ...bool, description: "Held back automatically when the report threshold was reached." },
    preview: { allOf: [obj({ text: { ...str, description: "Plain text." }, status: str })], nullable: true, description: "A short description of the content; null when it is gone." },
  }),
  ModerationDecision: obj({
    targetType,
    targetId: str,
    decision: { type: "string", enum: ["UPHELD", "DISMISSED"] },
    reports: int,
    strike: { allOf: [obj({ id: str, expiresAt: date })], nullable: true, description: "Upheld: the strike the author received." },
    restrictedUntil: { ...nullableDate, description: "Upheld: the author is barred from posting until then (three active strikes)." },
    restored: { ...bool, description: "Dismissed: held-back content came back." },
  }),

  AdminCategory: obj({ id: str, slug: str, name: str, position: int, isActive: bool }),
  AdminCategoryList: obj({ items: { type: "array", items: ref("AdminCategory") } }),

  CampaignSegment: {
    type: "object",
    description: "Who a campaign goes to. Every criterion is optional and the ones present must all hold; `{}` is every active member.",
    properties: {
      roles: strings,
      plan: strings,
      interests: strings,
      lastActive: {
        oneOf: [obj({ withinDays: int }), obj({ inactiveDays: int })],
        description: "Members active within the last `withinDays` days, or not active for `inactiveDays` days.",
      },
      hasPurchased: bool,
    },
  },
  Campaign: obj({
    id: str,
    name: str,
    subject: str,
    bodyMarkdown: str,
    segment: ref("CampaignSegment"),
    status: campaignStatus,
    scheduledAt: nullableDate,
    startedAt: nullableDate,
    finishedAt: nullableDate,
    audienceSize: { type: "integer", nullable: true, description: "Fixed when sending starts; null before." },
    createdById: str,
    lastEditedById: str,
    approvedById: nullableStr,
    approvedAt: nullableDate,
    stats: obj({ delivered: int, opened: int, clicked: int, bounced: int, complained: int, failed: int, unknown: int }),
    createdAt: date,
    updatedAt: date,
  }),
  CampaignDetail: {
    allOf: [ref("Campaign"), obj({ recipients: countMap("Recipients by state."), skipped: countMap("Skipped recipients by reason.") })],
  },
  CampaignPreview: obj({ audience: { ...int, description: "Active members the segment matches right now. A count only." }, requiresApproval: { ...bool, description: "True above 10,000 members: another admin must approve before sending." },
    subject: { ...str, description: "The subject members will see." },
    html: { ...str, description: "The full email as members will get it, from the same renderer the sender uses, with the asking admin's own unsubscribe link in the footer. Show it in a sandboxed iframe (srcdoc, no scripts); never insert it into the page." },
  }),
  CampaignTestSent: obj({ sent: { ...bool, enum: [true] } }),

  AnalyticsMetric: obj({
    key: str,
    label: str,
    group: { type: "string", enum: ["users", "sales", "learning", "reels", "gigs", "campaigns", "moderation"] },
    unit: { type: "string", enum: ["count", "paise"] },
    aggregation: { type: "string", enum: ["sum", "latest"], description: "`sum`: the range total adds the days up. `latest`: the last day's value (a level or a distinct count)." },
    approximate: { ...bool, description: "True for estimates (HyperLogLog)." },
    value: metricValue,
    asOf: { ...nullableStr, description: "The IST day a `latest` value is from; null for sums and when nothing was rolled up." },
  }),
  AnalyticsOverview: obj({ from: str, to: str, days: int, dataThrough: { ...nullableStr, description: "The newest rolled-up IST day in the range." }, metrics: { type: "array", items: ref("AnalyticsMetric") } }),
  AnalyticsSeries: obj({
    from: str,
    to: str,
    keys: { type: "array", items: obj({ key: str, label: str, unit: { type: "string", enum: ["count", "paise"] }, approximate: bool }) },
    dataThrough: nullableStr,
    points: { type: "array", items: obj({ day: str, values: { type: "object", additionalProperties: metricValue, description: "By metric key." } }) },
  }),
  AnalyticsFunnel: obj({ from: str, to: str, dataThrough: nullableStr, note: str, stages: { type: "array", items: obj({ key: str, label: str, count: int }) } }),
  AnalyticsRebuildAccepted: obj({ jobId: str, from: str, to: str }),

  Setting: obj({
    key: str,
    value: { oneOf: [{ type: "number" }, str, bool], description: "The stored value, or the default when none is stored. Its type is the type of `default`." },
    default: { oneOf: [{ type: "number" }, str, bool] },
    updatedAt: nullableDate,
  }),
  SettingList: obj({ items: { type: "array", items: ref("Setting") } }),
  SettingSaved: obj({ key: str, value: { oneOf: [{ type: "number" }, str, bool] } }),
  FeatureFlag: obj({
    key: str,
    enabled: bool,
    rules: {
      allOf: [obj({ allowUserIds: strings, percent: { ...int, description: "0 to 100." } }, [])],
      nullable: true,
      description: "Null: on for everyone while enabled. With rules the user must be in `allowUserIds` or fall in the first `percent` buckets.",
    },
    updatedAt: date,
  }),
  FeatureFlagList: obj({ items: { type: "array", items: ref("FeatureFlag") } }),

  OutboxDeadEvent: obj({
    id: str,
    type: str,
    payload: { type: "object", additionalProperties: true, description: "The event as it was enqueued." },
    attempts: int,
    lastError: nullableStr,
    createdAt: date,
    deadAt: date,
  }),
  AdminPayoutAccount: {
    allOf: [ref("PayoutAccount"), obj({ ownerType: { type: "string", enum: ["USER", "ORG"] }, ownerId: str, reviewFlag: { ...nullableStr, description: "DUPLICATE_PAN or NAME_MISMATCH while the account is held for review." } })],
  },
  AdminSubscription: obj({
    id: str,
    ownerType: { type: "string", enum: ["USER", "ORG"] },
    ownerId: str,
    status: { type: "string", enum: ["INCOMPLETE", "TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED", "EXPIRED"] },
    plan: obj({ key: str, name: str, versionId: str, interval: { type: "string", enum: ["MONTH", "YEAR"] }, pricePaise: ref("Money"), commissionBps: int }),
    currentPeriodEnd: nullableDate,
    cancelAtPeriodEnd: bool,
    graceEndsAt: nullableDate,
    razorpaySubscriptionId: nullableStr,
    createdAt: date,
  }),
};

/** The body of `GET /admin/analytics/export`: documented, not validated (it is CSV text, not JSON). */
export const analyticsCsvDescription = "The daily series as CSV, one row per IST day, one column per metric key after `day`. Money columns are paise. Text cells are protected against spreadsheet formulas. Sent as an attachment: the file name is in `Content-Disposition`.";
