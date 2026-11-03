import { z } from "zod";

const secret = (name: string) => z.string({ required_error: `${name} is required` }).min(32, `${name} must be at least 32 characters`);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: secret("JWT_SECRET"),
  OTP_PEPPER: secret("OTP_PEPPER"),
  PLAYBACK_SECRET: secret("PLAYBACK_SECRET"),
  CORS_ORIGINS: z.string().min(1),
  // Public URL of the web app, used for links in emails.
  WEB_BASE_URL: z.string().url(),
  COOKIE_DOMAIN: z.string().min(1),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_PUBLIC_BUCKET: z.string().min(1),
  R2_PRIVATE_BUCKET: z.string().min(1),
  R2_PUBLIC_BASE_URL: z.string().url(),
  R2_PLAYBACK_BASE_URL: z.string().url(),
  R2_ENDPOINT: z.string().url().optional(),
  RESEND_API_KEY: z.string().min(1),
  RESEND_FROM_ADDRESS: z.string().min(1),
  RESEND_WEBHOOK_SECRET: z.string().min(1),
  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  // Verifies X-Razorpay-Signature on POST /v1/webhooks/razorpay (set on the Razorpay dashboard webhook, not the API key secret).
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
  // RazorpayX (payouts): the current account number the payouts debit, and its own webhook secret.
  RAZORPAYX_ACCOUNT_NUMBER: z.string().min(1),
  RAZORPAYX_WEBHOOK_SECRET: z.string().min(1),
  // Keys the HMAC of PAN numbers (duplicate-PAN detection). Falls back to OTP_PEPPER; set it to rotate independently.
  KYC_PEPPER: secret("KYC_PEPPER").optional(),
  SENTRY_DSN: z.string().url().optional(),
  // Number of reverse-proxy hops in front of the API whose X-Forwarded-For is trusted (0 = none).
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  SUPER_ADMIN_EMAIL: z.string().email(),
});

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    jwtSecret: e.JWT_SECRET,
    otpPepper: e.OTP_PEPPER,
    kycPepper: e.KYC_PEPPER ?? e.OTP_PEPPER,
    playbackSecret: e.PLAYBACK_SECRET,
    corsOrigins: e.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    webBaseUrl: e.WEB_BASE_URL.replace(/\/+$/, ""),
    cookieDomain: e.COOKIE_DOMAIN,
    r2: {
      accountId: e.R2_ACCOUNT_ID,
      accessKeyId: e.R2_ACCESS_KEY_ID,
      secretAccessKey: e.R2_SECRET_ACCESS_KEY,
      publicBucket: e.R2_PUBLIC_BUCKET,
      privateBucket: e.R2_PRIVATE_BUCKET,
      publicBaseUrl: e.R2_PUBLIC_BASE_URL,
      playbackBaseUrl: e.R2_PLAYBACK_BASE_URL,
      // Overridable so tests and local dev can point at MinIO.
      endpoint: e.R2_ENDPOINT ?? `https://${e.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    },
    resend: { apiKey: e.RESEND_API_KEY, fromAddress: e.RESEND_FROM_ADDRESS, webhookSecret: e.RESEND_WEBHOOK_SECRET },
    razorpay: { keyId: e.RAZORPAY_KEY_ID, keySecret: e.RAZORPAY_KEY_SECRET, webhookSecret: e.RAZORPAY_WEBHOOK_SECRET },
    razorpayx: { accountNumber: e.RAZORPAYX_ACCOUNT_NUMBER, webhookSecret: e.RAZORPAYX_WEBHOOK_SECRET },
    trustProxy: e.TRUST_PROXY,
    sentryDsn: e.SENTRY_DSN,
    superAdminEmail: e.SUPER_ADMIN_EMAIL.toLowerCase(),
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
