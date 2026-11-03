import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../clock/clock";
import { PrismaService } from "../prisma/prisma.service";
import { IDEMPOTENCY_RETENTION_MS } from "./idempotency.interceptor";

/** Deletes idempotency records past their 24 h retention (completed or abandoned). Run from the maintenance queue. */
@Injectable()
export class IdempotencyCleanup {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async purge(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - IDEMPOTENCY_RETENTION_MS);
    const res = await this.prisma.idempotencyRecord.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return res.count;
  }
}
