import { execSync } from "node:child_process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";

export interface TestContainers {
  databaseUrl: string;
  redisUrl: string;
  stop(): Promise<void>;
}

export async function startContainers(): Promise<TestContainers> {
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer("postgres:16-alpine").withDatabase("skiller").withUsername("skiller").withPassword("skiller").start(),
    new RedisContainer("redis:7-alpine").start(),
  ]);
  const databaseUrl = pg.getConnectionUri();
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "ignore" });
  return {
    databaseUrl,
    redisUrl: redis.getConnectionUrl(),
    stop: async () => {
      await Promise.all([pg.stop(), redis.stop()]);
    },
  };
}
