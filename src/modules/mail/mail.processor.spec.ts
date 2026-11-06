import type { Job } from "bullmq";
import { MailService } from "./mail.service";
import { MailJobData, MailProcessor } from "./mail.processor";
import { FakeResendClient } from "./resend.client";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { MailHooks } from "./mail-hooks";

function prismaWith(suppressions: Record<string, string>) {
  return {
    emailSuppression: {
      findUnique: async ({ where }: { where: { email: string } }) =>
        suppressions[where.email] ? { email: where.email, reason: suppressions[where.email] } : null,
    },
  };
}

function job(data: MailJobData): Job<MailJobData> {
  return { id: "job-1", name: "send", data } as unknown as Job<MailJobData>;
}

function setup(suppressions: Record<string, string> = {}) {
  const client = new FakeResendClient();
  const processor = new MailProcessor(prismaWith(suppressions) as never, client, new ProcessorRegistry(), new MailHooks());
  return { client, processor };
}

const otpData = { code: "493817", purpose: "LOGIN", expiresInMin: 10 } as const;

describe("MailProcessor", () => {
  it("renders the OTP code in both html and text with the login subject", async () => {
    const { client, processor } = setup();
    await processor.process(job({ template: "otp", to: "a@example.com", data: otpData, category: "transactional" }));

    expect(client.sent).toHaveLength(1);
    const msg = client.sent[0];
    expect(msg.to).toBe("a@example.com");
    expect(msg.subject).toBe("Your Skiller sign-in code");
    expect(msg.html).toContain("493817");
    expect(msg.text).toContain("493817");
    expect(msg.html).toContain("<");
    expect(msg.text).not.toContain("<html");
  });

  it("uses a different subject for step-up codes", async () => {
    const { client, processor } = setup();
    await processor.process(
      job({ template: "otp", to: "a@example.com", data: { ...otpData, purpose: "STEP_UP" }, category: "transactional" }),
    );
    expect(client.sent[0].subject).toBe("Your Skiller verification code");
  });

  it("skips transactional mail to a hard-bounced address", async () => {
    const { client, processor } = setup({ "bounced@example.com": "bounced" });
    await processor.process(job({ template: "otp", to: "Bounced@Example.com", data: otpData, category: "transactional" }));
    expect(client.sent).toHaveLength(0);
  });

  it("still sends transactional mail to a complained address", async () => {
    const { client, processor } = setup({ "c@example.com": "complained" });
    await processor.process(job({ template: "otp", to: "c@example.com", data: otpData, category: "transactional" }));
    expect(client.sent).toHaveLength(1);
  });

  it("skips promotional mail to any suppressed address", async () => {
    const { client, processor } = setup({ "c@example.com": "complained" });
    await processor.process(job({ template: "welcome", to: "c@example.com", data: { name: "Cee" }, category: "promotional" }));
    expect(client.sent).toHaveLength(0);
  });

  it("throws on a Resend 5xx so the job is retried", async () => {
    const { client, processor } = setup();
    client.failWith(503);
    await expect(
      processor.process(job({ template: "otp", to: "a@example.com", data: otpData, category: "transactional" })),
    ).rejects.toThrow(/503/);
  });

  it("does not retry a permanent Resend 4xx", async () => {
    const { client, processor } = setup();
    client.failWith(422);
    await expect(
      processor.process(job({ template: "otp", to: "a@example.com", data: otpData, category: "transactional" })),
    ).rejects.toMatchObject({ name: "UnrecoverableError" });
  });
});

describe("MailService", () => {
  it("enqueues on the mail queue and never calls Resend inline", async () => {
    const added: unknown[][] = [];
    const queue = { add: async (...args: unknown[]) => void added.push(args) };
    const client = new FakeResendClient();
    const service = new MailService(queue as never);
    await service.send("otp", "a@example.com", otpData);
    expect(client.sent).toHaveLength(0);
    expect(added).toHaveLength(1);
    expect(added[0][0]).toBe("send");
    expect(added[0][1]).toEqual({ template: "otp", to: "a@example.com", data: otpData, category: "transactional" });
  });
});
