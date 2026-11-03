import { ModuleRef } from "@nestjs/core";
import { DynamicModule, Global, Inject, Module, OnApplicationShutdown, Provider } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { APP_CONFIG } from "../config/config.module";
import type { AppConfig } from "../config/config.schema";
import { ProcessorRegistry } from "./processor-registry";
import { QueueWorkerRunner } from "./queue-worker.runner";
import { QUEUE_CONNECTION, QueueName, QueueNames, queueToken } from "./queue.constants";
import { jobOptionsFor } from "./queue.options";

const names = Object.values(QueueNames) as QueueName[];


const queueProviders: Provider[] = names.map((name) => ({
  provide: queueToken(name),
  inject: [QUEUE_CONNECTION],
  useFactory: (connection: Redis) =>
    new Queue(name, {
      connection,
      defaultJobOptions: jobOptionsFor(name),
    }),
}));

@Global()
@Module({})
export class QueueModule implements OnApplicationShutdown {
  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: Redis,
    private readonly moduleRef: ModuleRef,
  ) {}

  static register(): DynamicModule {
    return {
      module: QueueModule,
      providers: [
        {
          provide: QUEUE_CONNECTION,
          inject: [APP_CONFIG],
          // BullMQ workers require maxRetriesPerRequest: null.
          useFactory: (config: AppConfig) => new IORedis(config.redisUrl, { maxRetriesPerRequest: null }),
        },
        ProcessorRegistry,
        QueueWorkerRunner,
        ...queueProviders,
      ],
      exports: [QUEUE_CONNECTION, ProcessorRegistry, QueueWorkerRunner, ...names.map(queueToken)],
    };
  }

  async onApplicationShutdown() {
    for (const name of names) await this.moduleRef.get<Queue>(queueToken(name), { strict: false }).close().catch(() => undefined);
    if (typeof this.connection.quit === "function") await this.connection.quit().catch(() => undefined);
  }
}
