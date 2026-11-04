import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Writes openapi.json at the repo root. Needs no database or Redis: the app is created (routes scanned) but never initialised.
// Placeholder env keeps config validation happy; real values win if set.
const placeholder = "x".repeat(40);
const defaults: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://openapi:openapi@127.0.0.1:1/openapi",
  REDIS_URL: "redis://127.0.0.1:1",
  JWT_SECRET: placeholder,
  OTP_PEPPER: placeholder,
  PLAYBACK_SECRET: placeholder,
  CORS_ORIGINS: "http://localhost:5173",
  WEB_BASE_URL: "http://localhost:5173",
  COOKIE_DOMAIN: "localhost",
  R2_ACCOUNT_ID: "openapi",
  R2_ACCESS_KEY_ID: "openapi",
  R2_SECRET_ACCESS_KEY: "openapi",
  R2_PUBLIC_BUCKET: "openapi-public",
  R2_PRIVATE_BUCKET: "openapi-private",
  R2_PUBLIC_BASE_URL: "http://localhost:9000/openapi-public",
  R2_PLAYBACK_BASE_URL: "http://localhost:8787",
  RESEND_API_KEY: "re_openapi",
  RESEND_FROM_ADDRESS: "Skiller <no-reply@skiller.test>",
  RESEND_WEBHOOK_SECRET: "whsec_dGVzdHNlY3JldA==",
  RAZORPAY_KEY_ID: "rzp_openapi",
  RAZORPAY_KEY_SECRET: "openapi",
  RAZORPAY_WEBHOOK_SECRET: "openapi",
  RAZORPAYX_ACCOUNT_NUMBER: "2323230000000001",
  RAZORPAYX_WEBHOOK_SECRET: "openapi-x",
  SUPER_ADMIN_EMAIL: "admin@skiller.test",
};
for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;

async function main() {
  const { NestFactory } = await import("@nestjs/core");
  const { AppModule } = await import("../src/app.module");
  const { configureApp } = await import("../src/bootstrap");
  const { buildOpenApiDocument } = await import("../src/common/openapi/openapi");

  const app = configureApp(await NestFactory.create(AppModule, { rawBody: true, logger: false }));
  const document = buildOpenApiDocument(app);
  const target = join(__dirname, "..", "openapi.json");
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`openapi.json written (${Object.keys(document.paths).length} paths)`);
  // The app was never initialised, so there is nothing to close; exit to drop the idle Redis/queue clients.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
