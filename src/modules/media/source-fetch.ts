import type { MediaAsset } from "@prisma/client";
import { PermanentMediaFailure } from "./media-lifecycle";
import { MEDIA_RULES, SOURCE_BUCKET } from "./media.rules";
import type { R2Client } from "./r2.client";

const isPreconditionFailed = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "PreconditionFailed" || e?.$metadata?.httpStatusCode === 412;
};

/**
 * Checks the uploaded source against what `complete` recorded: ETag unchanged (the object was not replaced through a still
 * valid presigned URL), size equal to the declared size and within the purpose's limit. Returns the ETag to read with.
 */
export async function verifySource(r2: R2Client, asset: MediaAsset, maxBytes: number = MEDIA_RULES[asset.purpose].maxBytes): Promise<string | undefined> {
  const head = await r2.head(SOURCE_BUCKET, asset.objectKey);
  if (!head) throw new Error(`source object missing: ${asset.objectKey}`); // transient until proven otherwise: let BullMQ retry
  if (asset.sourceEtag && head.etag !== asset.sourceEtag) throw new PermanentMediaFailure("SOURCE_CHANGED");
  if (head.size !== Number(asset.declaredSize) || head.size > maxBytes) throw new PermanentMediaFailure("UPLOAD_SIZE_MISMATCH");
  return asset.sourceEtag ?? head.etag;
}

/** Verifies, then streams the source to `dest` (never into memory). The read is conditional on the ETag. */
export async function fetchSource(r2: R2Client, asset: MediaAsset, dest: string, maxBytes?: number): Promise<void> {
  const etag = await verifySource(r2, asset, maxBytes);
  try {
    await r2.downloadTo(SOURCE_BUCKET, asset.objectKey, dest, { ifMatch: etag });
  } catch (err) {
    if (isPreconditionFailed(err)) throw new PermanentMediaFailure("SOURCE_CHANGED");
    throw err;
  }
}

export { isPreconditionFailed };
