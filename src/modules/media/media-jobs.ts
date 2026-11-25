import type { MediaPurpose } from "@prisma/client";
import type { Queue } from "bullmq";
import { QueueNames, type QueueName } from "../../common/queue/queue.constants";
import { FILE_JOB, IMAGE_JOB, MEDIA_JOB_ATTEMPTS, MEDIA_RULES, TRANSCODE_JOB } from "./media.rules";

/** Long course lessons have no duration cap, so they get their own queue and a reel never waits behind a lesson (DAT-4). */
export const queueNameFor = (purpose: MediaPurpose): QueueName => {
  const kind = MEDIA_RULES[purpose].kind;
  if (kind !== "video") return QueueNames.mediaLight;
  return purpose === "COURSE_LESSON" ? QueueNames.mediaTranscodeLong : QueueNames.mediaTranscode;
};

export const jobNameFor = (purpose: MediaPurpose): string => {
  const kind = MEDIA_RULES[purpose].kind;
  return kind === "image" ? IMAGE_JOB : kind === "video" ? TRANSCODE_JOB : FILE_JOB;
};

export interface MediaJobData {
  assetId: string;
  /** How many times the stuck-asset sweep has re-queued this asset (0 / absent for the upload's own job). */
  sweep?: number;
}

/** Queues the processing job of an asset. The jobId is the asset id, so a second add while the first exists is a no-op. */
export function enqueueMediaJob(queue: Queue, purpose: MediaPurpose, assetId: string, sweep = 0) {
  const data: MediaJobData = sweep > 0 ? { assetId, sweep } : { assetId };
  return queue.add(jobNameFor(purpose), data, { jobId: assetId, attempts: MEDIA_JOB_ATTEMPTS, backoff: { type: "fixed", delay: 5000 } });
}
