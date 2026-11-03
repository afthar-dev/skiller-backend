/**
 * Registry of notification types and their preference defaults. In-app defaults to on for every type;
 * email defaults to on only for transactional types. OTP mail is not a notification and never goes through here.
 */
export const NOTIFICATION_TYPES = {
  welcome: { transactional: true },
  "media.ready": { transactional: false },
  "media.failed": { transactional: true },
  "role.granted": { transactional: false },
} as const;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export const NOTIFICATION_TYPE_KEYS = Object.keys(NOTIFICATION_TYPES) as [NotificationType, ...NotificationType[]];

export interface EffectivePreference {
  type: NotificationType;
  inApp: boolean;
  email: boolean;
}

export const defaultPreference = (type: NotificationType): EffectivePreference => ({
  type,
  inApp: true,
  email: NOTIFICATION_TYPES[type].transactional,
});
