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
  it("API_BASE_URL is required in production (the unsubscribe link must reach the API) and optional elsewhere", () => {
    const prod = { ...validEnv, NODE_ENV: "production", CORS_ORIGINS: "https://app.skiller.in", COOKIE_DOMAIN: ".skiller.in" };
    expect(() => loadConfig(prod)).toThrow(/API_BASE_URL/);
    expect(loadConfig({ ...prod, API_BASE_URL: "https://api.skiller.in/" }).apiBaseUrl).toBe("https://api.skiller.in");
    expect(loadConfig(validEnv).apiBaseUrl).toBe("https://app.skiller.in");
  });

  it("API_BASE_URL is required in production (the unsubscribe link must reach the API) and optional elsewhere", () => {
    const prod = { ...validEnv, NODE_ENV: "production", CORS_ORIGINS: "https://app.skiller.in", COOKIE_DOMAIN: ".skiller.in" };
    expect(() => loadConfig(prod)).toThrow(/API_BASE_URL/);
    expect(loadConfig({ ...prod, API_BASE_URL: "https://api.skiller.in/" }).apiBaseUrl).toBe("https://api.skiller.in");
    expect(loadConfig(validEnv).apiBaseUrl).toBe("https://app.skiller.in");
  });

  it("RESEND_BASE_URL is rejected in production and reaches config.resend.baseUrl elsewhere", () => {
    const base = { ...validEnv, RESEND_BASE_URL: "http://127.0.0.1:4010" };
    const prod = { ...base, NODE_ENV: "production", API_BASE_URL: "https://api.skiller.in" };
    expect(() => loadConfig(prod)).toThrow(ConfigError);
    expect(() => loadConfig(prod)).toThrow(/RESEND_BASE_URL/);
    expect(loadConfig({ ...base, NODE_ENV: "development" }).resend.baseUrl).toBe("http://127.0.0.1:4010");
    expect(loadConfig(validEnv).resend.baseUrl).toBeUndefined();
  });

  it("RAZORPAY_BASE_URL is rejected in production and reaches config.razorpay.baseUrl elsewhere", () => {
    const base = { ...validEnv, RAZORPAY_BASE_URL: "http://127.0.0.1:4020/v1/" };
    const prod = { ...base, NODE_ENV: "production", API_BASE_URL: "https://api.skiller.in" };
    expect(() => loadConfig(prod)).toThrow(ConfigError);
    expect(() => loadConfig(prod)).toThrow(/RAZORPAY_BASE_URL/);
    expect(loadConfig({ ...base, NODE_ENV: "development" }).razorpay.baseUrl).toBe("http://127.0.0.1:4020/v1");
    expect(loadConfig(validEnv).razorpay.baseUrl).toBeUndefined();
  });

  it("SSR_SHARED_SECRET is optional and needs at least 32 characters", () => {
    expect(loadConfig(validEnv).ssrSharedSecret).toBeUndefined();
    expect(loadConfig({ ...validEnv, SSR_SHARED_SECRET: "x".repeat(32) }).ssrSharedSecret).toBe("x".repeat(32));
    expect(() => loadConfig({ ...validEnv, SSR_SHARED_SECRET: "x".repeat(31) })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv, SSR_SHARED_SECRET: "x".repeat(31) })).toThrow(/SSR_SHARED_SECRET/);
  });

  it("TRUST_PROXY defaults to 0 and parses a hop count", () => {
    expect(loadConfig(validEnv).trustProxy).toBe(0);
    expect(loadConfig({ ...validEnv, TRUST_PROXY: "2" }).trustProxy).toBe(2);
    expect(() => loadConfig({ ...validEnv, TRUST_PROXY: "-1" })).toThrow(ConfigError);
  });

  describe("production hardening", () => {
    const prod = { ...validEnv, NODE_ENV: "production", API_BASE_URL: "https://api.skiller.in", CORS_ORIGINS: "https://skiller.in", COOKIE_DOMAIN: ".skiller.in" };

    it("accepts https origins under COOKIE_DOMAIN", () => {
      expect(loadConfig(prod).corsOrigins).toEqual(["https://skiller.in"]);
      expect(loadConfig({ ...prod, CORS_ORIGINS: "https://skiller.in, https://www.skiller.in" }).corsOrigins).toHaveLength(2);
    });

    it.each(["*", "https://skiller.in,*", "http://skiller.in", "https://*.vercel.app", "https://skiller.vercel.app", "https://skiller.in/app", "skiller.in", "https://evil-skiller.in"])(
      "rejects CORS_ORIGINS=%s",
      (origins) => {
        expect(() => loadConfig({ ...prod, CORS_ORIGINS: origins })).toThrow(ConfigError);
        expect(() => loadConfig({ ...prod, CORS_ORIGINS: origins })).toThrow(/CORS_ORIGINS/);
      },
    );

    it("does not apply the CORS rules outside production", () => {
      expect(loadConfig({ ...validEnv, CORS_ORIGINS: "http://localhost:5173,*" }).corsOrigins).toContain("*");
    });

    it("more than one trusted proxy hop needs ORIGIN_SHARED_SECRET (direct onrender.com access could spoof X-Forwarded-For)", () => {
      expect(loadConfig({ ...prod, TRUST_PROXY: "1" }).trustProxy).toBe(1);
      expect(() => loadConfig({ ...prod, TRUST_PROXY: "2" })).toThrow(/ORIGIN_SHARED_SECRET/);
      const ok = loadConfig({ ...prod, TRUST_PROXY: "2", ORIGIN_SHARED_SECRET: "o".repeat(32) });
      expect(ok.originSharedSecret).toBe("o".repeat(32));
      expect(() => loadConfig({ ...prod, ORIGIN_SHARED_SECRET: "short" })).toThrow(/ORIGIN_SHARED_SECRET/);
      expect(loadConfig({ ...validEnv, TRUST_PROXY: "2" }).trustProxy).toBe(2);
    });
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

  it("keys PAN hashing with KYC_PEPPER, falling back to OTP_PEPPER, and rejects a short one", () => {
    expect(loadConfig(validEnv).kycPepper).toBe(validEnv.OTP_PEPPER);
    const own = "k".repeat(40);
    expect(loadConfig({ ...validEnv, KYC_PEPPER: own }).kycPepper).toBe(own);
    expect(() => loadConfig({ ...validEnv, KYC_PEPPER: "short" })).toThrow(/KYC_PEPPER/);
  });

  it("rejects one value for both webhook secrets", () => {
    expect(() => loadConfig({ ...validEnv, RAZORPAYX_WEBHOOK_SECRET: validEnv.RAZORPAY_WEBHOOK_SECRET })).toThrow(/RAZORPAYX_WEBHOOK_SECRET.*differ/);
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
