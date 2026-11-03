import { startContainers } from "./containers";

// Runs once per Jest invocation; workers inherit these env vars.
export default async function globalSetup() {
  const containers = await startContainers();
  process.env.DATABASE_URL = containers.databaseUrl;
  process.env.REDIS_URL = containers.redisUrl;
  (globalThis as { __containers?: typeof containers }).__containers = containers;
}
