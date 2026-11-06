import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { PrismaService } from "../../common/prisma/prisma.service";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { AuditService } from "../audit";
import type { DayRange } from "./analytics.service";
import { ANALYTICS_REBUILD_JOB, type RebuildJobData } from "./rollup.processor";

export interface ActionMeta {
  ip?: string;
  requestId?: string;
}

/** Queues a rebuild of past days (the worker runs it) and records who asked, in the same transaction as nothing else can fail after it. */
@Injectable()
export class RebuildService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
  ) {}

  async request(actorId: string, range: DayRange, meta: ActionMeta = {}): Promise<{ jobId: string; from: string; to: string }> {
    const job = await this.maintenanceQueue.add(ANALYTICS_REBUILD_JOB, { from: range.from, to: range.to } satisfies RebuildJobData, { attempts: 3, backoff: { type: "exponential", delay: 30_000 } });
    const jobId = String(job.id);
    await this.prisma.$transaction((tx) =>
      this.audit.record(tx, { actorId, action: "analytics.rebuild", targetType: "analytics", targetId: jobId, before: null, after: { from: range.from, to: range.to }, ...meta }),
    );
    return { jobId, from: range.from, to: range.to };
  }
}
