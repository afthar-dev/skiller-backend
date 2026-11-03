import {
  AbortMultipartUploadCommand,
  CopyObjectCommand,
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
import { PART_PRESIGN_TTL_SEC, PRESIGN_TTL_SEC } from "./media.rules";

const isMissing = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
};
// Parts carry no content type of their own (the final object gets the one given at CreateMultipartUpload).
const PART_SIGNED_HEADERS = new Set(["content-length"]);
const SIGNED_HEADERS = new Set(["content-length", "content-type"]);

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

  /** One presigned UploadPart URL per part (numbered from 1). Each URL signs that part's exact Content-Length. */
  presignParts(bucket: MediaBucket, key: string, uploadId: string, parts: { partNumber: number; size: number }[]): Promise<string[]> {
    return Promise.all(
      parts.map(({ partNumber, size }) =>
        getSignedUrl(this.s3, new UploadPartCommand({ Bucket: this.buckets[bucket], Key: key, UploadId: uploadId, PartNumber: partNumber, ContentLength: size }), {
          expiresIn: PART_PRESIGN_TTL_SEC,
          signableHeaders: PART_SIGNED_HEADERS,
        }),
      ),
    );
  }

  /** Single PUT that only accepts exactly contentLength bytes of contentType (both are part of the signature). */
  presignPut(bucket: MediaBucket, key: string, opts: { contentLength: number; contentType: string }): Promise<string> {
    return getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.buckets[bucket], Key: key, ContentLength: opts.contentLength, ContentType: opts.contentType }),
      { expiresIn: PRESIGN_TTL_SEC, signableHeaders: SIGNED_HEADERS },
    );
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
  async head(bucket: MediaBucket, key: string): Promise<{ size: number; etag: string | undefined } | null> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.buckets[bucket], Key: key }));
      return { size: Number(res.ContentLength ?? 0), etag: res.ETag };
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

  /** ifMatch makes the read fail with PreconditionFailed when the object was replaced since its ETag was recorded. */
  async getObject(bucket: MediaBucket, key: string, opts: { ifMatch?: string; range?: string } = {}): Promise<Readable> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.buckets[bucket], Key: key, IfMatch: opts.ifMatch, Range: opts.range }));
    return res.Body as Readable;
  }

  /** Streams to disk: sources can be several GB. */
  async downloadTo(bucket: MediaBucket, key: string, path: string, opts: { ifMatch?: string } = {}): Promise<void> {
    await pipeline(await this.getObject(bucket, key, opts), createWriteStream(path));
  }

  /** First length bytes (for magic-number checks). */
  async readHead(bucket: MediaBucket, key: string, length: number, opts: { ifMatch?: string } = {}): Promise<Buffer> {
    const stream = await this.getObject(bucket, key, { ...opts, range: `bytes=0-${length - 1}` });
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
    return Buffer.concat(chunks);
  }

  async copy(bucket: MediaBucket, fromKey: string, toKey: string): Promise<void> {
    const source = encodeURIComponent(`${this.buckets[bucket]}/${fromKey}`).replace(/%2F/g, "/");
    await this.s3.send(new CopyObjectCommand({ Bucket: this.buckets[bucket], Key: toKey, CopySource: source }));
  }

  async putObject(bucket: MediaBucket, key: string, body: Buffer | Uint8Array | string, contentType: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.buckets[bucket], Key: key, Body: body, ContentType: contentType }));
  }
}
