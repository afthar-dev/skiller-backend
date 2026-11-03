import "./instrument";
import { createApp } from "./create-app";

async function main() {
  const { app, config } = await createApp();
  await app.listen(config.port);
}

void main();
