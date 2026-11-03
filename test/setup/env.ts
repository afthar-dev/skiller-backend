// Baseline env for tests. Containers override DATABASE_URL / REDIS_URL / R2_ENDPOINT.
const secret = "test-secret-".padEnd(40, "x");

export function applyTestEnv(overrides: Record<string, string> = {}) {
  Object.assign(process.env, {
    NODE_ENV: "test",
    PORT: "4999",
    DATABASE_URL: "postgresql://skiller:skiller@localhost:5432/skiller",
    REDIS_URL: "redis://localhost:6379",
    JWT_SECRET: secret,
    OTP_PEPPER: secret,
    PLAYBACK_SECRET: secret,
    CORS_ORIGINS: "http://localhost:5173",
    COOKIE_DOMAIN: "localhost",
    R2_ACCOUNT_ID: "test",
    R2_ACCESS_KEY_ID: "minioadmin",
    R2_SECRET_ACCESS_KEY: "minioadmin",
    R2_PUBLIC_BUCKET: "skiller-public",
    R2_PRIVATE_BUCKET: "skiller-private",
    R2_PUBLIC_BASE_URL: "http://localhost:9000/skiller-public",
    R2_PLAYBACK_BASE_URL: "http://localhost:8787",
    RESEND_API_KEY: "re_test",
    RESEND_FROM_ADDRESS: "Skiller <no-reply@skiller.test>",
    RESEND_WEBHOOK_SECRET: "whsec_dGVzdHNlY3JldA==",
    TRUST_PROXY: "1",
    SUPER_ADMIN_EMAIL: "admin@skiller.test",
    ...overrides,
  });
}
