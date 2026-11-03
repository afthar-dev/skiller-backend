import { z } from "zod";

/** Typed registry of platform settings: per-key Zod schema and default. Unknown keys cannot be read or written. */
export const SETTINGS = {
  /** Days a payment is held before payout. */
  hold_days: { schema: z.number().int().min(0).max(90), default: 7 },
  /** Max upload size for a course lesson video, in MB. */
  max_upload_mb_course_lesson: { schema: z.number().int().min(1).max(51200), default: 5120 },
  /** Max reel length in seconds. */
  reel_max_seconds: { schema: z.number().int().min(1).max(600), default: 90 },
  /** GST rate in basis points (1800 = 18%). Platform fees and subscription prices are GST-inclusive (plan decision 1). */
  gst_bps: { schema: z.number().int().min(0).max(10_000), default: 1800 },
  /** TDS rate in basis points withheld on payouts; 0 until the CA confirms (plan decision 2). */
  tds_bps: { schema: z.number().int().min(0).max(10_000), default: 0 },
  /** Smallest payout a seller can request, in paise (50000 = INR 500). */
  min_payout_paise: { schema: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), default: 50_000 },
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
