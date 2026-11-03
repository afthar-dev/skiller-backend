import { Module, forwardRef } from "@nestjs/common";
import { UsersModule } from "../users/users.module";
import { MediaLifecycle } from "./media-lifecycle";
import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";
import { R2Client } from "./r2.client";

/** API side of media: upload sessions and `attach`. The processors live in MediaWorkerModule (worker process only). */
@Module({
  // users -> media (profile avatar/banner attach) and media -> users (isCreator): a module-level cycle only, no provider cycle.
  imports: [forwardRef(() => UsersModule)],
  controllers: [MediaController],
  providers: [R2Client, MediaLifecycle, MediaService],
  exports: [MediaService],
})
export class MediaModule {}
