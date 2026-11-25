import { Injectable, OnModuleInit } from "@nestjs/common";
import { EventBus } from "../../common/outbox/event-bus";
import { ProgressService } from "./progress.service";

/** Turns the outbox request written by a curriculum edit into the background recompute job (at-least-once and idempotent: repeats collapse). */
@Injectable()
export class ProgressRecomputeHandler implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly progress: ProgressService,
  ) {}

  onModuleInit() {
    this.bus.on("course.progress_recompute_requested", async (e) => {
      await this.progress.scheduleRecompute(e.courseId);
    });
  }
}
