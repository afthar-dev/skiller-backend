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
  const env = { ...process.env, DATABASE_URL: databaseUrl, SUPER_ADMIN_EMAIL: "admin@skiller.test" };
  execSync("npx prisma migrate deploy", { env, stdio: "ignore" });
  // Permissions, system roles (member, support, ...) and the bootstrap super admin: sign-up needs the `member` role to exist.
  execSync("npx prisma db seed", { env, stdio: "inherit" });
  return {
    databaseUrl,
    redisUrl: redis.getConnectionUrl(),
    stop: async () => {
      await Promise.all([pg.stop(), redis.stop()]);
    },
  };
}
