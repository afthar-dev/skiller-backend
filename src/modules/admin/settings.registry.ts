import { z } from "zod";
import { REFUND_WINDOW_DAYS } from "../../common/refund-window";

/**
 * Typed registry of platform settings: per-key Zod schema and default. Unknown keys cannot be read or written.
 * `writeSchema` is a stricter rule applied only to new writes through the API (reads keep using `schema`, so a value already stored is never discarded).
 */
export const SETTINGS = {
  /**
   * Days a payment is held before payout. A write must be at least the refund window (MON-5): releasing earlier lets a seller withdraw money
   * that a still-eligible refund then has to claw back from an AVAILABLE balance that is already gone.
   */
  hold_days: { schema: z.number().int().min(0).max(90), writeSchema: z.number().int().min(REFUND_WINDOW_DAYS).max(90), default: 7 },
  /** Max upload size for a course lesson video, in MB. */
  max_upload_mb_course_lesson: { schema: z.number().int().min(1).max(51200), default: 5120 },
  /** Max reel length in seconds. */
  reel_max_seconds: { schema: z.number().int().min(1).max(600), default: 90 },
  /** Distinct members who must report the same content before it is hidden until a moderator decides. */
  report_autohide_threshold: { schema: z.number().int().min(1).max(1000), default: 5 },
  /** When true, promotional campaigns go only to members who explicitly opted in (the `marketing_opt_in` preference); when false, to everyone who has not unsubscribed. Confirm with counsel whether the DPDP Act requires opt-in. */
  marketing_opt_in_required: { schema: z.boolean(), default: false },
  /** Promotional emails sent per second across the platform (the Resend plan's limit); transactional mail is never limited. Takes effect within a minute. */
  promo_send_per_second: { schema: z.number().int().min(1).max(500), default: 8 },
  /** GST rate in basis points (1800 = 18%). Platform fees and subscription prices are GST-inclusive (plan decision 1). */
  gst_bps: { schema: z.number().int().min(0).max(10_000), default: 1800 },
  /** TDS rate in basis points withheld on payouts; 0 until the CA confirms (plan decision 2). */
  tds_bps: { schema: z.number().int().min(0).max(10_000), default: 0 },
  /** Smallest payout a seller can request, in paise (50000 = INR 500). */
  min_payout_paise: { schema: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), default: 50_000 },
  /** Largest single UPI payout in paise (the UPI per-transaction limit; 10000000 = INR 1,00,000). */
  upi_max_payout_paise: { schema: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), default: 10_000_000 },
  /** The platform's GSTIN, printed on invoices; empty until the registration is through (invoices then say "GSTIN: applied for"). */
  platform_gstin: { schema: z.string().regex(/^(|[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])$/, "a 15 character GSTIN or empty"), default: "" },
  /** Legal name printed on invoices and credit notes. */
  platform_legal_name: { schema: z.string().trim().min(1).max(200), default: "Skiller" },
  /** Registered address printed on invoices and credit notes. */
  platform_address: { schema: z.string().trim().max(500), default: "" },
  /** Two-digit GST state code of the platform (place of supply when the buyer's state is not known); empty until known. */
  platform_state_code: { schema: z.string().regex(/^(|[0-9]{2})$/, "a two digit GST state code or empty"), default: "" },
  /** Service accounting code printed on invoices (998439: other online content services). */
  sac_code: { schema: z.string().regex(/^[0-9]{4,8}$/, "4 to 8 digits"), default: "998439" },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]["schema"]>;
export const SETTING_KEYS = Object.keys(SETTINGS) as [SettingKey, ...SettingKey[]];

/** Validates a value for a write: the key's `writeSchema` when it has one, else its `schema`. Throws ZodError. */
export function parseSettingWrite(key: SettingKey, value: unknown): unknown {
  const def = SETTINGS[key] as { schema: z.ZodTypeAny; writeSchema?: z.ZodTypeAny };
  return (def.writeSchema ?? def.schema).parse(value);
}
