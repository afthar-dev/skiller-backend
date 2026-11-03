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
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]["schema"]>;
export const SETTING_KEYS = Object.keys(SETTINGS) as [SettingKey, ...SettingKey[]];
