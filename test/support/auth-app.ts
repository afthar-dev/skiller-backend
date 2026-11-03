import { INestApplication, ModuleMetadata } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import { TestingModuleBuilder } from "@nestjs/testing";
import request from "supertest";
import { CLOCK } from "../../src/common/clock/clock";
import { QueueWorkerRunner } from "../../src/common/queue/queue-worker.runner";
import { FakeResendClient, RESEND_CLIENT } from "../../src/modules/mail/resend.client";
import { createTestApp } from "../setup/app";
import { FakeClock } from "./fake-clock";

export const uniqueEmail = (prefix = "user") => `${prefix}-${randomUUID()}@example.com`;
/** Unique client IP per call (random: jest gives each suite its own module state, but Redis is shared across suites). */
export const uniqueIp = () => {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2]}`;
};

export interface Cookie {
  value: string;
  raw: string;
}

export function readRefreshCookie(res: { headers: Record<string, unknown> }): Cookie | null {
  const header = res.headers["set-cookie"] as string[] | string | undefined;
  const list = Array.isArray(header) ? header : header ? [header] : [];
  const raw = list.find((c) => c.startsWith("skiller_rt="));
  if (!raw) return null;
  return { raw, value: raw.split(";")[0].slice("skiller_rt=".length) };
}

export interface AuthTestApp {
  app: INestApplication;
  clock: FakeClock;
  mail: FakeResendClient;
  close(): Promise<void>;
  /** Waits for the OTP mail sent after `after` messages to this address and returns its code. */
  codeFor(email: string, after?: number): Promise<string>;
  requestOtp(email: string, ip?: string): Promise<{ challengeId: string; expiresAt: string }>;
  login(email?: string): Promise<{ email: string; ip: string; userId: string; accessToken: string; cookie: Cookie; isNew: boolean }>;
}

/** Full AppModule with a controllable clock, a fake Resend client and an in-process queue worker so OTP mails are delivered. */
export async function createAuthTestApp(
  extra: Omit<ModuleMetadata, "imports"> = {},
  customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<AuthTestApp> {
  const clock = new FakeClock();
  const mail = new FakeResendClient();
  const app = await createTestApp(
    (b) => {
      const base = b.overrideProvider(CLOCK).useValue(clock).overrideProvider(RESEND_CLIENT).useValue(mail);
      return customize ? customize(base) : base;
    },
    extra,
  );
  const runner = app.get(QueueWorkerRunner);
  await runner.start();

  const sentTo = (email: string) => mail.sent.filter((m) => m.to === email.toLowerCase());

  const codeFor: AuthTestApp["codeFor"] = async (email, after = 0) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const list = sentTo(email);
      if (list.length > after) {
        const match = /\b(\d{6})\b/.exec(list[list.length - 1].text);
        if (match) return match[1];
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no OTP mail for ${email}`);
  };

  const requestOtp: AuthTestApp["requestOtp"] = async (email, ip = uniqueIp()) => {
    const res = await request(app.getHttpServer()).post("/v1/auth/otp/request").set("X-Forwarded-For", ip).send({ email });
    if (res.status !== 202) throw new Error(`otp request failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };

  const login: AuthTestApp["login"] = async (email = uniqueEmail()) => {
    const ip = uniqueIp();
    const before = sentTo(email).length;
    const { challengeId } = await requestOtp(email, ip);
    const code = await codeFor(email, before);
    const res = await request(app.getHttpServer())
      .post("/v1/auth/otp/verify")
      .set("X-Forwarded-For", ip)
      .set("User-Agent", "jest-agent")
      .send({ challengeId, code });
    if (res.status !== 200) throw new Error(`verify failed: ${res.status} ${JSON.stringify(res.body)}`);
    const cookie = readRefreshCookie(res);
    if (!cookie) throw new Error("no refresh cookie");
    return { email: email.toLowerCase(), ip, userId: res.body.user.id, accessToken: res.body.accessToken, cookie, isNew: res.body.user.isNew };
  };

  return {
    app,
    clock,
    mail,
    codeFor,
    requestOtp,
    login,
    async close() {
      await runner.stop();
      await app.close();
    },
  };
}
