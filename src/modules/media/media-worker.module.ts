import { Module } from "@nestjs/common";
import { ClockModule } from "../../common/clock/clock";
import { AccountService } from "../identity/account.service";
import { MediaCleanupProcessor } from "./media-cleanup.processor";
import { MediaFailedMailHandler } from "./media-failed-mail.handler";
import { MediaLifecycle } from "./media-lifecycle";
import { FileProcessor } from "./file.processor";
import { ImageProcessor } from "./image.processor";
import { R2Client } from "./r2.client";
import { TranscodeProcessor } from "./transcode.processor";

/** Worker-process side of media: transcode / image / cleanup processors and the failure-mail handler. */
@Module({
  imports: [ClockModule],
  providers: [R2Client, MediaLifecycle, AccountService, TranscodeProcessor, ImageProcessor, FileProcessor, MediaCleanupProcessor, MediaFailedMailHandler],
  exports: [MediaCleanupProcessor],
})
export class MediaWorkerModule {}
