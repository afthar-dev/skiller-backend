import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { QueueNames } from "../../common/queue/queue.constants";
import type { MailJobData } from "./mail.processor";
import type { MailCategory, MailData, MailTemplate } from "./mail.types";

@Injectable()
export class MailService {
  constructor(@InjectQueue(QueueNames.mail) private readonly queue: Queue) {}

  /** Enqueues only; the worker renders and calls Resend. */
  async send<T extends MailTemplate>(
    template: T,
    to: string,
    data: MailData[T],
    opts: { category: MailCategory } = { category: "transactional" },
  ): Promise<void> {
    const job: MailJobData = { template, to, data, category: opts.category } as MailJobData;
    // The OTP code is plaintext in the job data: drop the job as soon as it is done (or shortly after failing).
    const retention = template === "otp" ? { removeOnComplete: true, removeOnFail: { age: 3600 } } : {};
    await this.queue.add("send", job, retention);
  }
}
