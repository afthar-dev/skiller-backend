import { Global, Module } from "@nestjs/common";
import { ClockModule } from "../clock/clock";
import { EventBus } from "./event-bus";
import { OutboxProcessor } from "./outbox.processor";
import { OutboxRelay } from "./outbox.relay";
import { OutboxService } from "./outbox.service";

@Global()
@Module({
  imports: [ClockModule],
  providers: [OutboxService, OutboxRelay, OutboxProcessor, EventBus],
  exports: [OutboxService, OutboxRelay, EventBus],
})
export class OutboxModule {}
