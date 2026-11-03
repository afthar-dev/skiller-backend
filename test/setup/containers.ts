import { execSync } from "node:child_process";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { GenericContainer, Wait } from "testcontainers";

export const MINIO_USER = "minioadmin";
export const MINIO_PASSWORD = "minioadmin";
export const PUBLIC_BUCKET = "skiller-public";
export const PRIVATE_BUCKET = "skiller-private";
// S3-compatible stand-in for R2. Docker Hub's minio/minio is no longer pullable, so the default is Chainguard's public build;
// override with MINIO_IMAGE (e.g. minio/minio, quay.io/minio/minio) and MINIO_CMD if your registry differs.
const MINIO_IMAGE = process.env.MINIO_IMAGE ?? "cgr.dev/chainguard/minio:latest";

export interface TestContainers {
  databaseUrl: string;
  redisUrl: string;
  minioEndpoint: string;
  stop(): Promise<void>;
}

async function startMinio() {
  const container = await new GenericContainer(MINIO_IMAGE)
    .withEnvironment({ MINIO_ROOT_USER: MINIO_USER, MINIO_ROOT_PASSWORD: MINIO_PASSWORD })
    .withCommand(["server", "/tmp/data"])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/minio/health/ready", 9000))
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  const s3 = new S3Client({
    endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD },
  });
  for (const Bucket of [PUBLIC_BUCKET, PRIVATE_BUCKET]) await s3.send(new CreateBucketCommand({ Bucket }));
  s3.destroy();
  return { container, endpoint };
}

export async function startContainers(): Promise<TestContainers> {
  const [pg, redis, minio] = await Promise.all([
    new PostgreSqlContainer("postgres:16-alpine").withDatabase("skiller").withUsername("skiller").withPassword("skiller").start(),
    new RedisContainer("redis:7-alpine").start(),
    startMinio(),
  ]);
  const databaseUrl = pg.getConnectionUri();
  const env = { ...process.env, DATABASE_URL: databaseUrl, SUPER_ADMIN_EMAIL: "admin@skiller.test" };
  execSync("npx prisma migrate deploy", { env, stdio: "ignore" });
  // Permissions, system roles (member, support, ...) and the bootstrap super admin: sign-up needs the `member` role to exist.
  execSync("npx prisma db seed", { env, stdio: "inherit" });
  return {
    databaseUrl,
    redisUrl: redis.getConnectionUrl(),
    minioEndpoint: minio.endpoint,
    stop: async () => {
      await Promise.all([pg.stop(), redis.stop(), minio.container.stop()]);
    },
  };
}
