import { ConfigError, loadConfig } from "./config.schema";

const secret = "x".repeat(32);
const validEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  PORT: "4000",
  DATABASE_URL: "postgresql://u:p@localhost:5432/skiller",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: secret,
  OTP_PEPPER: secret,
  PLAYBACK_SECRET: secret,
  CORS_ORIGINS: "http://localhost:5173, https://app.skiller.in",
  COOKIE_DOMAIN: "localhost",
  R2_ACCOUNT_ID: "acc",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_PUBLIC_BUCKET: "skiller-public",
  R2_PRIVATE_BUCKET: "skiller-private",
  R2_PUBLIC_BASE_URL: "https://media.skiller.in",
  R2_PLAYBACK_BASE_URL: "https://play.skiller.in",
  RESEND_API_KEY: "re_test",
  RESEND_FROM_ADDRESS: "Skiller <no-reply@skiller.in>",
  RESEND_WEBHOOK_SECRET: "whsec_test",
  RAZORPAY_KEY_ID: "rzp_test_key",
  RAZORPAY_KEY_SECRET: "key_secret",
  RAZORPAY_WEBHOOK_SECRET: "webhook_secret",
  RAZORPAYX_ACCOUNT_NUMBER: "2323230000000001",
  RAZORPAYX_WEBHOOK_SECRET: "webhookx_secret",
  SUPER_ADMIN_EMAIL: "admin@skiller.in",
  WEB_BASE_URL: "https://app.skiller.in/",
};

describe("loadConfig", () => {
  it("TRUST_PROXY defaults to 0 and parses a hop count", () => {
    expect(loadConfig(validEnv).trustProxy).toBe(0);
    expect(loadConfig({ ...validEnv, TRUST_PROXY: "2" }).trustProxy).toBe(2);
    expect(() => loadConfig({ ...validEnv, TRUST_PROXY: "-1" })).toThrow(ConfigError);
  });

  it("loads valid env", () => {
    const config = loadConfig(validEnv);
    expect(config.corsOrigins).toEqual(["http://localhost:5173", "https://app.skiller.in"]);
    expect(config.port).toBe(4000);
    expect(config.r2.privateBucket).toBe("skiller-private");
    expect(config.sentryDsn).toBeUndefined();
  });

  it("WEB_BASE_URL is required, must be a URL, and is exposed without a trailing slash", () => {
    expect(loadConfig(validEnv).webBaseUrl).toBe("https://app.skiller.in");
    const missing = { ...validEnv };
    delete missing.WEB_BASE_URL;
    expect(() => loadConfig(missing)).toThrow(/WEB_BASE_URL/);
    expect(() => loadConfig({ ...validEnv, WEB_BASE_URL: "not a url" })).toThrow(/WEB_BASE_URL/);
  });

  it("requires the Razorpay and RazorpayX settings and exposes them grouped", () => {
    const config = loadConfig(validEnv);
    expect(config.razorpay).toEqual({ keyId: "rzp_test_key", keySecret: "key_secret", webhookSecret: "webhook_secret" });
    expect(config.razorpayx).toEqual({ accountNumber: "2323230000000001", webhookSecret: "webhookx_secret" });
    for (const key of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "RAZORPAYX_ACCOUNT_NUMBER", "RAZORPAYX_WEBHOOK_SECRET"]) {
      const env = { ...validEnv };
      delete env[key];
      expect(() => loadConfig(env)).toThrow(new RegExp(key));
    }
  });

  it("rejects short jwt secret", () => {
    expect(() => loadConfig({ ...validEnv, JWT_SECRET: "short" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv, JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
  });

  it("reports all invalid keys at once", () => {
    const env = { ...validEnv };
    delete env.DATABASE_URL;
    delete env.REDIS_URL;
    let message = "";
    try {
      loadConfig(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("REDIS_URL");
  });
});
