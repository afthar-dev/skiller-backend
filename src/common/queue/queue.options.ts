import type { BackoffStrategy, JobsOptions } from "bullmq";
import { QueueName, QueueNames } from "./queue.constants";

export const CAPPED_EXPONENTIAL = "capped-exponential";
export const OUTBOX_BACKOFF_CAP_MS = 30 * 60 * 1000;

/** 1 s, 2 s, 4 s, ... doubling per attempt, never longer than `capMs`. */
export function cappedExponentialBackoff(attemptsMade: number, baseMs: number, capMs = OUTBOX_BACKOFF_CAP_MS): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attemptsMade - 1));
}

/** Worker-side strategy for the custom backoff type (BullMQ ships only fixed / exponential). */
export const backoffStrategy: BackoffStrategy = (attemptsMade, type, _err, job) =>
  type === CAPPED_EXPONENTIAL ? cappedExponentialBackoff(attemptsMade, job?.opts.backoff && typeof job.opts.backoff === "object" ? (job.opts.backoff.delay ?? 1000) : 1000) : 1000;

const BASE: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/**
 * Domain events (and payment webhooks, on the billing queue) are the platform's source of truth for side effects, so they are retried for hours (about 2.4 h in total)
 * and a job that still fails is kept (removeOnFail false) and flagged dead on its outbox row instead of vanishing.
 */
export const OUTBOX_JOB_OPTIONS: JobsOptions = {
  attempts: 15,
  backoff: { type: CAPPED_EXPONENTIAL, delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: false,
};

export const jobOptionsFor = (name: QueueName): JobsOptions => (name === QueueNames.outbox || name === QueueNames.billing ? OUTBOX_JOB_OPTIONS : BASE);
