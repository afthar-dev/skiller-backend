import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { configureApp } from "./bootstrap";
import { APP_CONFIG } from "./common/config/config.module";
import type { AppConfig } from "./common/config/config.schema";
import { setupSwagger } from "./common/openapi/openapi";

/**
 * Builds the HTTP application exactly as production does (main.ts only adds `listen`). Boot tests call this too, so a broken
 * module graph or import cycle fails a test instead of `node dist/main.js`.
 */
export async function createApp() {
  const app = configureApp(await NestFactory.create(AppModule, { rawBody: true, bufferLogs: true }));
  app.useLogger(app.get(Logger));
  const config = app.get<AppConfig>(APP_CONFIG);
  // Swagger UI at /v1/docs; never exposed in production (the committed openapi.json is the contract there).
  if (config.nodeEnv !== "production") setupSwagger(app);
  return { app, config };
}
