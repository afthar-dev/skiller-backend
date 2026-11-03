import { Controller, Get, Inject } from "@nestjs/common";
import { Public } from "./common/auth/public.decorator";
import type { Redis } from "ioredis";
import { AppError } from "./common/errors/app-error";
import { PrismaService } from "./common/prisma/prisma.service";
import { REDIS } from "./common/redis/redis.constants";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

@Public()
@ApiTags("Health")
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get("health")
  @ApiOperation({ summary: "Liveness" })
  health() {
    return { status: "ok" };
  }

  @Get("ready")
  @ApiOperation({ summary: "Readiness: database and Redis" })
  async ready() {
    const [database, redis] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(() => true, () => false),
      this.redis.ping().then((r) => r === "PONG", () => false),
    ]);
    if (!database || !redis) {
      throw new AppError("NOT_READY", 503, "Service not ready", { checks: { database, redis } });
    }
    return { status: "ready", checks: { database, redis } };
  }
}
