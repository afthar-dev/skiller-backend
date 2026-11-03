import { INestApplication } from "@nestjs/common";
import { Test, TestingModuleBuilder } from "@nestjs/testing";
import { applyTestEnv } from "./env";

// Keeps DATABASE_URL / REDIS_URL from global setup; everything else from the test env.
export async function createTestApp(customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder): Promise<INestApplication> {
  applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
  const { AppModule } = await import("../../src/app.module");
  const { configureApp } = await import("../../src/bootstrap");
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (customize) builder = customize(builder);
  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.init();
  return app;
}
