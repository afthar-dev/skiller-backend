import { createHash, randomInt, randomUUID } from "node:crypto";
import request from "supertest";
import type { PrismaService } from "../../src/common/prisma/prisma.service";
import type { FakeRazorpayXClient } from "../../src/modules/billing";
import { CreatorService } from "../../src/modules/users";
import { uniqueIp, type AuthTestApp } from "./auth-app";

export type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
export const DAY = 86_400_000;

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** A well-formed PAN that no other test uses. */
export const randomPan = () => Array.from({ length: 5 }, () => LETTERS[randomInt(26)]).join("") + String(randomInt(10000)).padStart(4, "0") + LETTERS[randomInt(26)];
export const randomAccountNumber = () => String(randomInt(100000000, 999999999)) + String(randomInt(100000, 999999));

export async function until<T>(read: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

export function payoutHelpers(t: AuthTestApp, prisma: PrismaService, fakeX: FakeRazorpayXClient) {
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  async function stepUp(session: Session) {
    const before = t.mail.sent.filter((m) => m.to === session.email).length;
    const res = await http().post("/v1/auth/step-up/request").set(auth(session)).set("X-Forwarded-For", uniqueIp());
    if (res.status !== 202) throw new Error(`step-up request failed: ${res.status}`);
    const code = await t.codeFor(session.email, before);
    await http().post("/v1/auth/step-up/verify").set(auth(session)).send({ challengeId: res.body.challengeId, code }).expect(204);
  }

  async function creator(): Promise<Session> {
    const s = await t.login();
    await t.app.get(CreatorService).becomeCreator(s.userId);
    return s;
  }

  const bankBody = (over: { pan?: string; accountNumber?: string; holderName?: string; ifsc?: string } = {}) => ({
    type: "BANK",
    bank: { ifsc: over.ifsc ?? "HDFC0001234", accountNumber: over.accountNumber ?? randomAccountNumber(), holderName: over.holderName ?? "Asha Rao" },
    pan: over.pan ?? randomPan(),
  });
  const upiBody = (vpa = `asha${randomInt(100000)}@okhdfc`, pan = randomPan()) => ({ type: "UPI", upi: { vpa }, pan });

  const putAccount = (s: Session, body: object) => http().put("/v1/wallet/payout-account").set(auth(s)).send(body);

  /** Delivers a signed RazorpayX webhook through the real endpoint and waits until the billing worker has processed it. */
  async function deliverX(hook: { body: string; headers: Record<string, string> }) {
    let r = http().post("/v1/webhooks/razorpayx");
    for (const [k, v] of Object.entries(hook.headers)) r = r.set(k, v);
    const res = await r.send(hook.body);
    if (res.status !== 200) throw new Error(`webhook rejected: ${res.status} ${JSON.stringify(res.body)}`);
    // An identical body under a new event id is recognised as the same delivery, so look the row up either way.
    const bodySha256 = createHash("sha256").update(hook.body).digest("hex");
    const row = await prisma.webhookEvent.findFirstOrThrow({ where: { provider: "RAZORPAYX", OR: [{ eventId: hook.headers["x-razorpay-event-id"] }, { bodySha256 }] } });
    await until(async () => (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } })).processedAt);
    return row;
  }

  /** A creator with a VERIFIED first payout account (a first account has no cooldown). The clock is not touched. */
  async function creatorWithAccount(body: object = bankBody()): Promise<Session & { accountId: string }> {
    const s = await creator();
    await stepUp(s);
    const res = await putAccount(s, body);
    if (res.status !== 200) throw new Error(`put payout account failed: ${res.status} ${JSON.stringify(res.body)}`);
    const row = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: res.body.id } });
    await deliverX(fakeX.validationWebhook(row.razorpayxFundAccountId, "active"));
    return Object.assign(s, { accountId: row.id });
  }

  return { http, auth, stepUp, creator, bankBody, upiBody, putAccount, deliverX, creatorWithAccount, uid: () => randomUUID().slice(0, 8) };
}
