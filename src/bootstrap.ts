import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { captureRawBody } from "./common/http/raw-body-capture";
import { APP_CONFIG } from "./common/config/config.module";
import type { AppConfig } from "./common/config/config.schema";

// Shared by main.ts and the e2e harness so tests run against the same HTTP stack.
export function configureApp<T extends INestApplication>(app: T): T {
  const config = app.get<AppConfig>(APP_CONFIG);
  // req.ip (per-IP rate limits, session/OTP audit IPs) is only the real client behind a proxy when this is the right hop count.
  if (config.trustProxy > 0) app.getHttpAdapter().getInstance().set("trust proxy", config.trustProxy);
  app.setGlobalPrefix("v1");
  app.use(helmet());
  app.use(captureRawBody(["/v1/webhooks/razorpay", "/v1/webhooks/razorpayx"]));
  app.use(cookieParser());
  // Content-Disposition: the web app reads the file name of a CSV export from it (another origin sees only exposed headers).
  app.enableCors({ origin: config.corsOrigins, credentials: true, exposedHeaders: ["Content-Disposition"] });
  app.enableShutdownHooks();
  return app;
}
