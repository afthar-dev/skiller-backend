import { INestApplication } from "@nestjs/common";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { QueueNames, queueToken } from "../../src/common/queue";
import { QueueWorkerRunner } from "../../src/common/queue/queue-worker.runner";
import { FakeRazorpayClient, RAZORPAY_CLIENT, WebhookDispatcher } from "../../src/modules/billing";
import { createTestApp } from "../setup/app";

async function until<T>(read: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("POST /v1/webhooks/razorpay and /razorpayx", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dispatcher: WebhookDispatcher;
  // Same secrets as test/setup/env.ts.
  const fake = new FakeRazorpayClient({
    keySecret: "razorpay-key-secret-for-tests",
    webhookSecret: "razorpay-webhook-secret-for-tests",
    webhookXSecret: "razorpayx-webhook-secret-for-tests",
  });
  const typeName = () => `test.${randomUUID()}`;
  const post = (path: string, hook: { body: string; headers: Record<string, string> }) => {
    let r = request(app.getHttpServer()).post(path);
    for (const [k, v] of Object.entries(hook.headers)) r = r.set(k, v);
    return r.send(hook.body);
  };

  beforeAll(async () => {
    app = await createTestApp((b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake));
    prisma = app.get(PrismaService);
    dispatcher = app.get(WebhookDispatcher);
    await app.get(QueueWorkerRunner).start(); // in-process worker: the billing queue is processed for real
  });
  afterAll(() => app?.close());

  it("stores a validly signed event once, enqueues a job with jobId = row id, and the handler runs", async () => {
    const type = typeName();
    const seen: Array<{ type: string; eventId: string; payload: Record<string, unknown> }> = [];
    dispatcher.on(type, async (e) => void seen.push(e));
    const hook = fake.webhook(type, { payment: { entity: { id: "pay_1" } } });

    const res = await post("/v1/webhooks/razorpay", hook);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const eventId = hook.headers["x-razorpay-event-id"];
    const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "RAZORPAY", eventId } } });
    expect(row.type).toBe(type);
    expect(row.payload).toMatchObject({ event: type, payload: { payment: { entity: { id: "pay_1" } } } });

    const queue = app.get<Queue>(queueToken(QueueNames.billing));
    const job = await queue.getJob(row.id);
    expect(job?.name).toBe("webhook.process");
    expect(job?.data).toEqual({ webhookEventId: row.id });

    const done = await until(async () => (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } })).processedAt);
    expect(done).toBeInstanceOf(Date);
    expect(seen).toHaveLength(1);
    expect(seen[0].eventId).toBe(eventId);
  });

  it("rejects a bad, missing or tampered signature with 400 WEBHOOK_SIGNATURE_INVALID and stores nothing", async () => {
    const hook = fake.webhook(typeName(), { a: 1 });
    const eventId = hook.headers["x-razorpay-event-id"];

    const wrong = await post("/v1/webhooks/razorpay", { ...hook, headers: { ...hook.headers, "x-razorpay-signature": "0".repeat(64) } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");

    const { "x-razorpay-signature": _omit, ...withoutSig } = hook.headers;
    expect((await post("/v1/webhooks/razorpay", { ...hook, headers: withoutSig })).body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");

    const tampered = await post("/v1/webhooks/razorpay", { ...hook, body: hook.body.replace('"a":1', '"a":2') });
    expect(tampered.body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");

    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(0);
  });

  it("the Razorpay secret does not authenticate the RazorpayX route, and vice versa", async () => {
    const hook = fake.webhook(typeName(), {});
    expect((await post("/v1/webhooks/razorpayx", hook)).body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    const hookX = fake.webhook(typeName(), {}, { provider: "RAZORPAYX" });
    expect((await post("/v1/webhooks/razorpay", hookX)).body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    expect(await prisma.webhookEvent.count({ where: { eventId: { in: [hook.headers["x-razorpay-event-id"], hookX.headers["x-razorpay-event-id"]] } } })).toBe(0);
  });

  it("requires the event id header (400 WEBHOOK_EVENT_ID_MISSING) after the signature checks out", async () => {
    const hook = fake.webhook(typeName(), {});
    const { "x-razorpay-event-id": _omit, ...headers } = hook.headers;
    const res = await post("/v1/webhooks/razorpay", { ...hook, headers });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("WEBHOOK_EVENT_ID_MISSING");
  });

  it("rejects a validly signed body that is not an event (400 WEBHOOK_PAYLOAD_INVALID)", async () => {
    const hook = fake.webhook(typeName(), {});
    const crypto = await import("node:crypto");
    // (Syntactically invalid JSON never reaches the controller: the body parser answers 400 itself.)
    for (const body of ["[]", '{"no":"event"}', '{"event":""}', '{"event":5}']) {
      const signed = { body, headers: { ...hook.headers, "x-razorpay-signature": crypto.createHmac("sha256", "razorpay-webhook-secret-for-tests").update(body).digest("hex") } };
      const res = await post("/v1/webhooks/razorpay", signed);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("WEBHOOK_PAYLOAD_INVALID");
    }
  });

  it("the same event id delivered twice (even concurrently) yields one row and one handler run", async () => {
    const type = typeName();
    const handler = jest.fn(async () => undefined);
    dispatcher.on(type, handler);
    const hook = fake.webhook(type, {}, { eventId: `evt_dup_${randomUUID()}` });

    const results = await Promise.all([post("/v1/webhooks/razorpay", hook), post("/v1/webhooks/razorpay", hook), post("/v1/webhooks/razorpay", hook)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await prisma.webhookEvent.count({ where: { provider: "RAZORPAY", eventId: hook.headers["x-razorpay-event-id"] } })).toBe(1);
    await until(async () => (await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: hook.headers["x-razorpay-event-id"] } })).processedAt);

    // A redelivery after it was processed is acknowledged and does nothing.
    expect((await post("/v1/webhooks/razorpay", hook)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("the same event id on the two providers is two events", async () => {
    const eventId = `evt_shared_${randomUUID()}`;
    expect((await post("/v1/webhooks/razorpay", fake.webhook(typeName(), {}, { eventId }))).status).toBe(200);
    expect((await post("/v1/webhooks/razorpayx", fake.webhook(typeName(), {}, { eventId, provider: "RAZORPAYX" }))).status).toBe(200);
    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(2);
  });

  it("an unknown event type is acknowledged and marked processed", async () => {
    const hook = fake.webhook(`nobody.handles.${randomUUID()}`, {});
    expect((await post("/v1/webhooks/razorpay", hook)).status).toBe(200);
    const row = await until(async () => {
      const r = await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: hook.headers["x-razorpay-event-id"] } });
      return r.processedAt ? r : null;
    });
    expect(row.lastError).toBeNull();
  });

  it("stores RazorpayX events under the RAZORPAYX provider", async () => {
    const type = typeName();
    const seen: string[] = [];
    dispatcher.on(type, async (e) => void seen.push(e.provider));
    const hook = fake.webhook(type, { payout: { entity: { id: "pout_1" } } }, { provider: "RAZORPAYX" });
    expect((await post("/v1/webhooks/razorpayx", hook)).status).toBe(200);
    await until(async () => seen.length > 0);
    expect(seen).toEqual(["RAZORPAYX"]);
    expect(await prisma.webhookEvent.count({ where: { provider: "RAZORPAYX", eventId: hook.headers["x-razorpay-event-id"] } })).toBe(1);
  });

  it("a handler that fails is retried by the queue; lastError is recorded, then cleared on success", async () => {
    const type = typeName();
    let calls = 0;
    dispatcher.on(type, async () => {
      calls++;
      if (calls === 1) throw new Error("handler failed once");
    });
    const hook = fake.webhook(type, {});
    expect((await post("/v1/webhooks/razorpay", hook)).status).toBe(200);
    const eventId = hook.headers["x-razorpay-event-id"];

    // The first attempt fails; the retry is delayed by the 1 s base backoff, so the error is observable in between.
    const failed = await until(async () => {
      const r = await prisma.webhookEvent.findFirstOrThrow({ where: { eventId } });
      return r.lastError ? r : null;
    });
    expect(failed.lastError).toBe("handler failed once");
    expect(failed.processedAt).toBeNull();
    expect(failed.attempts).toBe(1);

    const done = await until(async () => {
      const r = await prisma.webhookEvent.findFirstOrThrow({ where: { eventId } });
      return r.processedAt ? r : null;
    });
    expect(done.attempts).toBe(2);
    expect(done.lastError).toBeNull();
    expect(calls).toBe(2);
  });
});
