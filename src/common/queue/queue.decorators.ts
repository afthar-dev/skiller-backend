import { Inject } from "@nestjs/common";
import { QueueName, queueToken } from "./queue.constants";

export const InjectQueue = (name: QueueName) => Inject(queueToken(name));
