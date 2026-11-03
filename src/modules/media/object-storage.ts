import { Injectable, Module } from "@nestjs/common";
import { R2Client } from "./r2.client";

/**
 * The slice of object storage other modules may use (invoices today): write a private object, hand out a short-lived GET URL.
 * Everything else about buckets and keys stays inside media.
 */
@Injectable()
export class ObjectStorage {
  constructor(private readonly r2: R2Client) {}

  async putPrivate(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
    await this.r2.putObject("PRIVATE", key, body, contentType);
  }

  presignPrivateGet(key: string, opts: { expiresInSec: number; filename?: string }): Promise<string> {
    return this.r2.presignGet("PRIVATE", key, opts);
  }
}

/** Dependency-free module (config only), so billing can use storage without importing the rest of media. */
@Module({ providers: [R2Client, ObjectStorage], exports: [ObjectStorage] })
export class ObjectStorageModule {}
