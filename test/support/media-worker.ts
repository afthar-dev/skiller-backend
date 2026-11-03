import { readFileSync } from "node:fs";
import { Test } from "@nestjs/testing";
import type { MediaPurpose, Prisma } from "@prisma/client";
import type { Job } from "bullmq";
import { v7 as uuidv7 } from "uuid";
import { fixturePath } from "../fixtures/make-fixtures";
import { applyTestEnv } from "../setup/env";

/** The worker-side media providers (processors, R2, lifecycle) wired against the test containers, without starting BullMQ workers. */
export async function createMediaWorkerHarness() {
  applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
  const [{ ConfigModule }, { ClockModule }, { PrismaModule }, { RedisModule }, { QueueModule }, { OutboxModule }, { MailModule }, { MediaWorkerModule }] = await Promise.all([
    import("../../src/common/config/config.module"),
    import("../../src/common/clock/clock"),
    import("../../src/common/prisma/prisma.module"),
    import("../../src/common/redis/redis.module"),
    import("../../src/common/queue/queue.module"),
    import("../../src/common/outbox/outbox.module"),
    import("../../src/modules/mail/mail.module"),
    import("../../src/modules/media/media-worker.module"),
  ]);
  const [{ QueueWorkerRunner }, { PrismaService }, { R2Client }, { TranscodeProcessor }, { ImageProcessor }, { MediaCleanupProcessor }, { EventBus }, { QueueNames, queueToken }] = await Promise.all([
    import("../../src/common/queue/queue-worker.runner"),
    import("../../src/common/prisma/prisma.service"),
    import("../../src/modules/media/r2.client"),
    import("../../src/modules/media/transcode.processor"),
    import("../../src/modules/media/image.processor"),
    import("../../src/modules/media/media-cleanup.processor"),
    import("../../src/common/outbox/event-bus"),
    import("../../src/common/queue/queue.constants"),
  ]);

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, ClockModule, PrismaModule, RedisModule, QueueModule.register(), OutboxModule, MailModule, MediaWorkerModule],
  }).compile();
  await moduleRef.init();

  const prisma = moduleRef.get(PrismaService);
  const r2 = moduleRef.get(R2Client);

  const fakeJob = <T>(data: T, attemptsMade = 0, attempts = 2) => ({ data, attemptsMade, opts: { attempts } }) as unknown as Job<T>;

  /** Inserts an asset row. When `source` is given the bytes are PUT at the asset's object key (as a finished upload). */
  async function createAsset(opts: {
    purpose: MediaPurpose;
    ownerId?: string;
    status?: Prisma.MediaAssetCreateInput["status"];
    source?: Buffer | string; // bytes, or a fixture file name
    mime?: string;
    ageHours?: number;
    attached?: boolean;
    uploadId?: string;
  }) {
    const id = uuidv7();
    const ownerId = opts.ownerId ?? uuidv7();
    const bucket = opts.purpose === "COURSE_LESSON" || opts.purpose === "COURSE_RESOURCE" ? "PRIVATE" : "PUBLIC";
    const prefix = `${opts.purpose.toLowerCase()}/${ownerId}/${id}`;
    const body = typeof opts.source === "string" ? readFileSync(fixturePath(opts.source)) : opts.source;
    if (body) await r2.putObject(bucket, `${prefix}/source`, body, opts.mime ?? "application/octet-stream");
    const created = new Date(Date.now() - (opts.ageHours ?? 0) * 3600_000);
    const row = await prisma.mediaAsset.create({
      data: {
        id,
        ownerId,
        purpose: opts.purpose,
        bucket,
        status: opts.status ?? "PROCESSING",
        objectKey: `${prefix}/source`,
        filename: "clip.mp4",
        mime: opts.mime ?? "video/mp4",
        declaredSize: BigInt(body?.length ?? 1),
        uploadId: opts.uploadId,
        attachedAt: opts.attached ? new Date() : null,
        createdAt: created,
      },
    });
    return { row, prefix, bucket } as const;
  }

  const events = async (assetId: string, type: string) =>
    (await prisma.outboxEvent.findMany({ where: { type } })).filter((e) => (e.payload as { assetId?: string }).assetId === assetId);

  return {
    moduleRef,
    prisma,
    r2,
    transcode: moduleRef.get(TranscodeProcessor),
    image: moduleRef.get(ImageProcessor),
    cleanup: moduleRef.get(MediaCleanupProcessor),
    bus: moduleRef.get(EventBus),
    runner: moduleRef.get(QueueWorkerRunner),
    mediaQueue: moduleRef.get<import("bullmq").Queue>(queueToken(QueueNames.media)),
    mailQueue: moduleRef.get<import("bullmq").Queue>(queueToken(QueueNames.mail)),
    fakeJob,
    createAsset,
    events,
    close: async () => {
      await moduleRef.get(QueueWorkerRunner).stop();
      await moduleRef.close();
    },
  };
}

export type MediaWorkerHarness = Awaited<ReturnType<typeof createMediaWorkerHarness>>;
