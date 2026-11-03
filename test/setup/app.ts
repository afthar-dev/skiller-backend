import { INestApplication, ModuleMetadata } from "@nestjs/common";
import { Test, TestingModuleBuilder } from "@nestjs/testing";
import type { Express } from "express";
import { applyTestEnv } from "./env";

// Keeps DATABASE_URL / REDIS_URL from global setup; everything else from the test env.
// `extra` adds test-only controllers/providers beside AppModule.
export async function createTestApp(
  customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
  extra: Omit<ModuleMetadata, "imports"> = {},
): Promise<INestApplication> {
  applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
  const { AppModule } = await import("../../src/app.module");
  const { configureApp } = await import("../../src/bootstrap");
  let builder = Test.createTestingModule({ ...extra, imports: [AppModule] });
  if (customize) builder = customize(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  // Lets tests choose a client IP per request via X-Forwarded-For (per-IP rate limits would otherwise be shared).
  (app.getHttpAdapter().getInstance() as Express).set("trust proxy", true);
  configureApp(app);
  await app.init();
  return app;
}
