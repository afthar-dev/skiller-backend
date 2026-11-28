/* eslint-disable @typescript-eslint/no-explicit-any -- a hand-rolled Prisma delegate fake */
import { OtpService, OTP_HOURLY_SEND_CEILING } from "./otp.service";

interface Row {
  id: string;
  email: string;
  purpose: string;
  consumedAt: Date | null;
  ip: string;
  expiresAt: Date;
  createdAt: Date;
  attempts: number;
}

/** Just enough of Prisma's otpChallenge delegate for request() and the attempt budget. */
function fakePrisma(rows: Row[]) {
  const matches = (r: Row, w: Record<string, any>) =>
    (w.email === undefined || r.email === w.email) &&
    (w.purpose === undefined || r.purpose === w.purpose) &&
    (w.consumedAt === undefined || r.consumedAt === w.consumedAt) &&
    (w.ip === undefined || r.ip === w.ip) &&
    (w.expiresAt?.gt === undefined || r.expiresAt > w.expiresAt.gt) &&
    (w.createdAt?.gte === undefined || r.createdAt >= w.createdAt.gte) &&
    (w.id?.in === undefined || w.id.in.includes(r.id));
  const delegate = {
    count: async ({ where }: any) => rows.filter((r) => matches(r, where)).length,
    findMany: async ({ where }: any) => rows.filter((r) => matches(r, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
    updateMany: async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    create: async ({ data }: any) => {
      rows.push({ attempts: 0, consumedAt: null, ...data });
      return data;
    },
  };
  return { otpChallenge: delegate, $transaction: async (fn: any) => fn({ otpChallenge: delegate }), $queryRaw: jest.fn().mockResolvedValue([]) };
}

const NOW = new Date("2026-01-01T12:00:00Z");
const MIN = 60_000;

function build(rows: Row[]) {
  const prisma = fakePrisma(rows);
  const mail = { send: jest.fn().mockResolvedValue(undefined) };
  const svc = new OtpService(prisma as never, mail as never, { otpPepper: "p".repeat(32) } as never, { now: () => NOW } as never);
  return { svc, mail, prisma };
}
const row = (over: Partial<Row>): Row => ({ id: Math.random().toString(36), email: "v@example.com", purpose: "LOGIN", consumedAt: null, ip: "5.5.5.5", expiresAt: new Date(NOW.getTime() + 5 * MIN), createdAt: new Date(NOW.getTime() - MIN), attempts: 0, ...over });
const live = (rows: Row[]) => rows.filter((r) => r.consumedAt === null && r.expiresAt > NOW);

describe("OtpService abuse limits (SEC-2, SEC-3)", () => {
  it("a request from another address does not cancel the owner's code; one from the same address supersedes its own earlier code", async () => {
    const rows = [row({ id: "owner", ip: "5.5.5.5" })];
    const { svc } = build(rows);
    const stranger = await svc.request({ email: "v@example.com", purpose: "LOGIN", ip: "6.6.6.6" });
    await svc.request({ email: "v@example.com", purpose: "LOGIN", ip: "6.6.6.6" });
    await svc.request({ email: "v@example.com", purpose: "LOGIN", ip: "6.6.6.6" });
    const stillLive = live(rows).map((r) => r.id);
    expect(stillLive).toContain("owner");
    expect(stillLive).not.toContain(stranger.challengeId);
    expect(stillLive).toHaveLength(2);
  });

  it("step-up challenges keep the old rule: only the newest is live", async () => {
    const rows = [row({ id: "s1", purpose: "STEP_UP" })];
    const { svc } = build(rows);
    await svc.request({ email: "v@example.com", purpose: "STEP_UP", ip: "1.2.3.4", userId: "u" });
    expect(live(rows).filter((r) => r.purpose === "STEP_UP")).toHaveLength(1);
  });

  it("past the hourly send ceiling a request still answers like a normal one but sends nothing and creates nothing", async () => {
    const rows = Array.from({ length: OTP_HOURLY_SEND_CEILING }, () => row({ consumedAt: NOW }));
    const { svc, mail } = build(rows);
    const res = await svc.request({ email: "v@example.com", purpose: "LOGIN", ip: "9.9.9.9" });
    expect(res.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(mail.send).not.toHaveBeenCalled();
    expect(rows).toHaveLength(OTP_HOURLY_SEND_CEILING);
  });

  it("the ceiling is per email: another address is unaffected", async () => {
    const rows = Array.from({ length: OTP_HOURLY_SEND_CEILING }, () => row({ consumedAt: NOW }));
    const { svc, mail } = build(rows);
    await svc.request({ email: "other@example.com", purpose: "LOGIN", ip: "9.9.9.9" });
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it("failed guesses are capped per email across challenges: 5 challenges x 5 wrong codes, the next verify is refused before it is counted", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ id: `c${i}`, attempts: 5, createdAt: new Date(NOW.getTime() - (i + 1) * MIN) }));
    rows.push(row({ id: "fresh" }));
    const { svc, prisma } = build(rows);
    const err = await svc.verify("fresh", "123456", { purpose: "LOGIN" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "OTP_LOCKED", status: 429 });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("under the cap a verify goes on to the normal check; another email's attempts do not count", async () => {
    const rows = [row({ id: "other", email: "x@example.com", attempts: 5 }), row({ id: "mine", attempts: 3 })];
    const { svc, prisma } = build(rows);
    await svc.verify("mine", "123456", { purpose: "LOGIN" }).catch(() => undefined);
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });
});
