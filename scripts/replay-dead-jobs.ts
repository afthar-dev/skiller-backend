import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { replayFailed } from "../src/common/queue/replay-failed";

// Replays jobs that used all their attempts. The outbox and billing queues keep failed jobs for exactly this.
//   pnpm jobs:replay outbox            every failed domain-event job
//   pnpm jobs:replay billing <jobId>   one failed webhook / payout job (the job id is the webhook_events row id)
// A replayed outbox event is cleared from /admin/outbox/dead. Needs DATABASE_URL and REDIS_URL, like the worker.
async function main() {
  const [name, ...ids] = process.argv.slice(2);
  if (name !== "outbox" && name !== "billing") throw new Error("usage: jobs:replay <outbox|billing> [jobId...]");
  const connection = new IORedis(process.env.REDIS_URL ?? "", { maxRetriesPerRequest: null });
  const queue = new Queue(name, { connection });
  const prisma = new PrismaClient();
  try {
    const retried = await replayFailed(queue, ids.length ? ids : undefined);
    if (name === "outbox" && retried.length) await prisma.outboxEvent.updateMany({ where: { id: { in: retried } }, data: { deadAt: null, lastError: null } });
    console.log(`replayed ${retried.length} ${name} job(s)${retried.length ? `: ${retried.join(", ")}` : ""}`);
  } finally {
    await queue.close();
    await connection.quit();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
