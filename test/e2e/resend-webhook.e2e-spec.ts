import { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { Webhook } from "svix";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { createTestApp } from "../setup/app";

const SECRET = "whsec_dGVzdHNlY3JldA==";

function signed(body: object) {
  const payload = JSON.stringify(body);
  const id = `msg_${randomUUID()}`;
  const timestamp = new Date();
  const signature = new Webhook(SECRET).sign(id, timestamp, payload);
  return {
    payload,
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature,
    },
  };
}

describe("POST /v1/webhooks/resend", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(() => app?.close());

  it("records a suppression for email.bounced with a valid signature", async () => {
    const email = `bounce-${randomUUID()}@example.com`;
    const { payload, headers } = signed({ type: "email.bounced", created_at: new Date().toISOString(), data: { email_id: "e1", to: [email.toUpperCase()] } });
    const res = await request(app.getHttpServer()).post("/v1/webhooks/resend").set(headers).send(payload);
    expect(res.status).toBe(200);
    const row = await prisma.emailSuppression.findUniqueOrThrow({ where: { email } });
    expect(row.reason).toBe("bounced");
  });

  it("records a complaint, and a later complaint never downgrades a bounce", async () => {
    const email = `complain-${randomUUID()}@example.com`;
    const complaint = () => signed({ type: "email.complained", data: { email_id: "e2", to: [email] } });
    let s = complaint();
    await request(app.getHttpServer()).post("/v1/webhooks/resend").set(s.headers).send(s.payload).expect(200);
    expect((await prisma.emailSuppression.findUniqueOrThrow({ where: { email } })).reason).toBe("complained");

    s = signed({ type: "email.bounced", data: { email_id: "e3", to: [email] } });
    await request(app.getHttpServer()).post("/v1/webhooks/resend").set(s.headers).send(s.payload).expect(200);
    s = complaint();
    await request(app.getHttpServer()).post("/v1/webhooks/resend").set(s.headers).send(s.payload).expect(200);
    expect((await prisma.emailSuppression.findUniqueOrThrow({ where: { email } })).reason).toBe("bounced");
  });

  it("rejects a bad signature and writes nothing", async () => {
    const email = `forged-${randomUUID()}@example.com`;
    const { payload, headers } = signed({ type: "email.bounced", data: { email_id: "e4", to: [email] } });
    const res = await request(app.getHttpServer())
      .post("/v1/webhooks/resend")
      .set({ ...headers, "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" })
      .send(payload);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_SIGNATURE");
    expect(await prisma.emailSuppression.findUnique({ where: { email } })).toBeNull();
  });

  it("ignores unrelated event types", async () => {
    const { payload, headers } = signed({ type: "email.delivered", data: { email_id: "e5", to: ["x@example.com"] } });
    await request(app.getHttpServer()).post("/v1/webhooks/resend").set(headers).send(payload).expect(200);
  });
});
