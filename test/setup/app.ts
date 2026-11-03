import { INestApplication, ModuleMetadata } from "@nestjs/common";
import { Test, TestingModuleBuilder } from "@nestjs/testing";
import { applyTestEnv } from "./env";

// Keeps DATABASE_URL / REDIS_URL from global setup; everything else from the test env.
// `extra` adds test-only controllers/providers beside AppModule.
export async function createTestApp(
  customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
  extra: Omit<ModuleMetadata, "imports"> = {},
  beforeInit?: (app: INestApplication) => void,
): Promise<INestApplication> {
  applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
  const { AppModule } = await import("../../src/app.module");
  const { configureApp } = await import("../../src/bootstrap");
  let builder = Test.createTestingModule({ ...extra, imports: [AppModule] });
  if (customize) builder = customize(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app);
  beforeInit?.(app);
  await app.init();
  return app;
}
