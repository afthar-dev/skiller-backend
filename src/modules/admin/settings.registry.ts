import { z } from "zod";

/** Typed registry of platform settings: per-key Zod schema and default. Unknown keys cannot be read or written. */
export const SETTINGS = {
  /** Days a payment is held before payout. */
  hold_days: { schema: z.number().int().min(0).max(90), default: 7 },
  /** Max upload size for a course lesson video, in MB. */
  max_upload_mb_course_lesson: { schema: z.number().int().min(1).max(51200), default: 5120 },
  /** Max reel length in seconds. */
  reel_max_seconds: { schema: z.number().int().min(1).max(600), default: 90 },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]["schema"]>;
export const SETTING_KEYS = Object.keys(SETTINGS) as [SettingKey, ...SettingKey[]];
