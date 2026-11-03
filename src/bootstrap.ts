import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { APP_CONFIG } from "./common/config/config.module";
import type { AppConfig } from "./common/config/config.schema";

// Shared by main.ts and the e2e harness so tests run against the same HTTP stack.
export function configureApp<T extends INestApplication>(app: T): T {
  const config = app.get<AppConfig>(APP_CONFIG);
  app.setGlobalPrefix("v1");
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.enableShutdownHooks();
  return app;
}
