import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./bootstrap";
import { APP_CONFIG } from "./common/config/config.module";
import type { AppConfig } from "./common/config/config.schema";

async function main() {
  const app = configureApp(await NestFactory.create(AppModule));
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port);
}

void main();
