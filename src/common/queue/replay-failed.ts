import type { Job, Queue } from "bullmq";

/**
 * Retries the failed jobs of a queue (all of them, or only the given job ids). The outbox and billing queues keep their failed jobs (removeOnFail false), so a
 * replay is a plain retry: the job runs again from attempt 1 with its original payload and jobId. Returns the ids that were retried.
 */
export async function replayFailed(queue: Pick<Queue, "getFailed" | "getJob">, ids?: string[]): Promise<string[]> {
  const jobs: Job[] = ids ? (await Promise.all(ids.map((id) => queue.getJob(id)))).filter((j): j is Job => !!j) : await queue.getFailed(0, 1000);
  const retried: string[] = [];
  for (const job of jobs) {
    if (!(await job.isFailed())) continue;
    await job.retry("failed");
    retried.push(String(job.id));
  }
  return retried;
}
