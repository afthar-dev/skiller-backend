export const QueueNames = {
  outbox: "outbox",
  mail: "mail",
  media: "media",
  maintenance: "maintenance",
} as const;

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];

export const QUEUE_CONNECTION = Symbol("QUEUE_CONNECTION");

export const queueToken = (name: QueueName) => `QUEUE:${name}`;
