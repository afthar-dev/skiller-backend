import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";
import type { MediaBucket } from "@prisma/client";
import { createWriteStream } from "node:fs";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { PRESIGN_TTL_SEC } from "./media.rules";

const isMissing = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
};
export const isNoSuchUpload = (err: unknown) => (err as { name?: string })?.name === "NoSuchUpload";

/** Thin S3 wrapper (Cloudflare R2 in production, MinIO in tests). */
@Injectable()
export class R2Client implements OnApplicationShutdown {
  private readonly s3: S3Client;
  private readonly buckets: Record<MediaBucket, string>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.s3 = new S3Client({
      region: "auto",
      endpoint: config.r2.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: config.r2.accessKeyId, secretAccessKey: config.r2.secretAccessKey },
      // Newer SDKs add CRC32 checksum params to presigned URLs by default, which a browser's plain PUT cannot satisfy.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    this.buckets = { PUBLIC: config.r2.publicBucket, PRIVATE: config.r2.privateBucket };
  }

  onApplicationShutdown() {
    this.s3.destroy();
  }

  async createMultipart(bucket: MediaBucket, key: string, mime: string): Promise<string> {
    const res = await this.s3.send(new CreateMultipartUploadCommand({ Bucket: this.buckets[bucket], Key: key, ContentType: mime }));
    if (!res.UploadId) throw new Error("storage returned no upload id");
    return res.UploadId;
  }

  /** One presigned UploadPart URL per part (numbered from 1), valid for 1 h. */
  presignParts(bucket: MediaBucket, key: string, uploadId: string, partCount: number): Promise<string[]> {
    return Promise.all(
      Array.from({ length: partCount }, (_, i) =>
        getSignedUrl(this.s3, new UploadPartCommand({ Bucket: this.buckets[bucket], Key: key, UploadId: uploadId, PartNumber: i + 1 }), { expiresIn: PRESIGN_TTL_SEC }),
      ),
    );
  }

  presignPut(bucket: MediaBucket, key: string): Promise<string> {
    return getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.buckets[bucket], Key: key }), { expiresIn: PRESIGN_TTL_SEC });
  }

  async completeMultipart(bucket: MediaBucket, key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.buckets[bucket],
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }

  async abortMultipart(bucket: MediaBucket, key: string, uploadId: string): Promise<void> {
    await this.s3.send(new AbortMultipartUploadCommand({ Bucket: this.buckets[bucket], Key: key, UploadId: uploadId })).catch((err) => {
      if (!isNoSuchUpload(err)) throw err;
    });
  }

  /** `null` when the object does not exist. */
  async head(bucket: MediaBucket, key: string): Promise<{ size: number } | null> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.buckets[bucket], Key: key }));
      return { size: Number(res.ContentLength ?? 0) };
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async delete(bucket: MediaBucket, key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.buckets[bucket], Key: key }));
  }

  /** Deletes every object whose key starts with `prefix`. Returns how many were removed. */
  async deletePrefix(bucket: MediaBucket, prefix: string): Promise<number> {
    let removed = 0;
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.buckets[bucket], Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length > 0) {
        await this.s3.send(new DeleteObjectsCommand({ Bucket: this.buckets[bucket], Delete: { Objects: keys, Quiet: true } }));
        removed += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return removed;
  }

  async listKeys(bucket: MediaBucket, prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.buckets[bucket], Prefix: prefix, ContinuationToken: token }));
      keys.push(...(page.Contents ?? []).map((o) => o.Key!));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  async getObject(bucket: MediaBucket, key: string): Promise<Readable> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.buckets[bucket], Key: key }));
    return res.Body as Readable;
  }

  /** Streams to disk: sources can be several GB. */
  async downloadTo(bucket: MediaBucket, key: string, path: string): Promise<void> {
    await pipeline(await this.getObject(bucket, key), createWriteStream(path));
  }

  async putObject(bucket: MediaBucket, key: string, body: Buffer | Uint8Array | string, contentType: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.buckets[bucket], Key: key, Body: body, ContentType: contentType }));
  }
}
