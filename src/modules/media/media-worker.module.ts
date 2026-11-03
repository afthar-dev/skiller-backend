import { Module } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { MediaCleanupProcessor } from "./media-cleanup.processor";
import { MediaLifecycle } from "./media-lifecycle";
import { FileProcessor } from "./file.processor";
import { ImageProcessor } from "./image.processor";
import { R2Client } from "./r2.client";
import { TranscodeProcessor } from "./transcode.processor";

/** Worker-process side of media: transcode / image / cleanup processors (the failure mail is sent by the notifications handlers). */
@Module({
  imports: [ClockModule],
  providers: [R2Client, MediaLifecycle, TranscodeProcessor, ImageProcessor, FileProcessor, MediaCleanupProcessor],
  exports: [MediaCleanupProcessor],
})
export class MediaWorkerModule {}
