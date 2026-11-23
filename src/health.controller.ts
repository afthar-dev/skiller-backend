import { Controller, Get, Inject } from "@nestjs/common";
import { Public } from "./common/auth/public.decorator";
import type { Redis } from "ioredis";
import { AppError } from "./common/errors/app-error";
import { PrismaService } from "./common/prisma/prisma.service";
import { REDIS } from "./common/redis/redis.constants";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

/** Each readiness check gets this long; a stalled pool or a hung socket must answer "not ready", not hang the probe. */
export const READY_CHECK_TIMEOUT_MS = 2000;

/** Resolves true if `check` succeeds within `ms`, false if it fails, throws or does not answer in time. */
export function checkWithin(check: () => Promise<boolean>, ms: number = READY_CHECK_TIMEOUT_MS): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    let started: Promise<boolean>;
    try {
      started = check();
    } catch {
      clearTimeout(timer);
      resolve(false);
      return;
    }
    started.then(
      (ok) => {
        clearTimeout(timer);
        resolve(ok);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

@Public()
@ApiTags("Health")
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get("health")
  @ApiOperation({ summary: "Liveness (no dependencies: use this for the platform health check)" })
  health() {
    return { status: "ok" };
  }

  @Get("ready")
  @ApiOperation({ summary: "Readiness: database and Redis" })
  async ready() {
    const [database, redis] = await Promise.all([
      checkWithin(() => this.prisma.$queryRaw`SELECT 1`.then(() => true)),
      checkWithin(() => this.redis.ping().then((r) => r === "PONG")),
    ]);
    if (!database || !redis) {
      throw new AppError("NOT_READY", 503, "Service not ready", { checks: { database, redis } });
    }
    return { status: "ready", checks: { database, redis } };
  }
}
