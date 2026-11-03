import type { Queue } from "bullmq";
import { QueueNames, queueToken } from "../../src/common/queue/queue.constants";

/**
 * Repeatable schedulers (the 1 s outbox relay, hourly media cleanup) live in Redis, which every suite in a jest run shares.
 * A spec that calls schedule() must remove them in afterAll: otherwise every later suite's in-process worker keeps relaying
 * the whole outbox, delivering other tests' events (welcome / role.granted notifications, ...) at random moments.
 */
export async function removeAllSchedulers(ctx: { get<T>(token: string | symbol, opts?: { strict: boolean }): T }): Promise<void> {
  for (const name of Object.values(QueueNames)) {
    const queue = ctx.get<Queue>(queueToken(name), { strict: false });
    for (const s of await queue.getJobSchedulers()) await queue.removeJobScheduler(s.key);
  }
}
