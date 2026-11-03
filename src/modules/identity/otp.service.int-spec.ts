import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import { applyTestEnv } from "../../../test/setup/env";
import { FakeClock } from "../../../test/support/fake-clock";
import { CLOCK } from "../../common/clock/clock";
import { ConfigModule } from "../../common/config/config.module";
import { AppError } from "../../common/errors/app-error";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { PrismaService } from "../../common/prisma/prisma.service";
import { MailService } from "../mail";
import { OtpService } from "./otp.service";

const MIN = 60_000;

describe("OtpService", () => {
  let moduleRef: TestingModule;
  let otp: OtpService;
  let prisma: PrismaService;
  const clock = new FakeClock();
  const codes = new Map<string, string>(); // email -> last code mailed
  const mail = {
    send: jest.fn(async (_t: string, to: string, data: { code: string }) => {
      codes.set(to, data.code);
    }),
  };
  const email = () => `otp-${randomUUID()}@example.com`;
  const wrongCode = (code: string) => (code === "000000" ? "111111" : "000000");

  beforeAll(async () => {
    applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
      providers: [OtpService, { provide: MailService, useValue: mail }, { provide: CLOCK, useValue: clock }],
    }).compile();
    await moduleRef.init();
    otp = moduleRef.get(OtpService);
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(() => moduleRef?.close());

  const code = (e: string) => codes.get(e)!;
  const codeError = async (p: Promise<unknown>) => (await p.catch((e: unknown) => e)) as AppError;

  it("accepts the correct code once; a second verify of the same code is OTP_INVALID", async () => {
    const e = email();
    const { challengeId } = await otp.request({ email: e, purpose: "LOGIN", ip: "1.1.1.1" });
    await expect(otp.verify(challengeId, code(e))).resolves.toEqual({ email: e, purpose: "LOGIN", userId: undefined });
    const err = await codeError(otp.verify(challengeId, code(e)));
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("OTP_INVALID");
  });

  it("stores only a hash and mails a 6 digit code", async () => {
    const e = email();
    const { challengeId } = await otp.request({ email: e, purpose: "LOGIN", ip: "1.1.1.1" });
    expect(code(e)).toMatch(/^\d{6}$/);
    const row = await prisma.otpChallenge.findUniqueOrThrow({ where: { id: challengeId } });
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.codeHash).not.toContain(code(e));
  });

  it("reports attemptsLeft on a wrong code, then locks after 5 wrong codes even for the correct one", async () => {
    const e = email();
    const { challengeId } = await otp.request({ email: e, purpose: "LOGIN", ip: "1.1.1.1" });
    const bad = wrongCode(code(e));
    for (let i = 1; i <= 5; i++) {
      const err = await codeError(otp.verify(challengeId, bad));
      expect(err.code).toBe("OTP_INVALID");
      expect(err.status).toBe(400);
      expect(err.details).toEqual({ attemptsLeft: 5 - i });
    }
    const locked = await codeError(otp.verify(challengeId, code(e)));
    expect(locked.code).toBe("OTP_LOCKED");
    expect(locked.status).toBe(429);
  });

  it("rejects an expired code with OTP_EXPIRED (+10 min 1 s)", async () => {
    const e = email();
    const { challengeId, expiresAt } = await otp.request({ email: e, purpose: "LOGIN", ip: "1.1.1.1" });
    expect(expiresAt.getTime() - clock.now().getTime()).toBe(10 * MIN);
    clock.advance(10 * MIN + 1000);
    const err = await codeError(otp.verify(challengeId, code(e)));
    expect(err.code).toBe("OTP_EXPIRED");
    expect(err.status).toBe(400);
    clock.advance(-(10 * MIN + 1000));
  });

  it("10 parallel verifies with the correct code: exactly one succeeds", async () => {
    const e = email();
    const { challengeId } = await otp.request({ email: e, purpose: "LOGIN", ip: "1.1.1.1" });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => otp.verify(challengeId, code(e))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as AppError).code).toMatch(/^OTP_/);
  });

  it("a new request invalidates the previous challenge's code", async () => {
    const e = email();
    const first = await otp.request({ email: e, purpose: "LOGIN", ip: "1.1.1.1" });
    const firstCode = code(e);
    const second = await otp.request({ email: e, purpose: "LOGIN", ip: "1.1.1.1" });
    expect((await codeError(otp.verify(first.challengeId, firstCode))).code).toBe("OTP_INVALID");
    await expect(otp.verify(second.challengeId, code(e))).resolves.toMatchObject({ email: e });
  });

  it("does not invalidate challenges of a different purpose", async () => {
    const e = email();
    const login = await otp.request({ email: e, purpose: "LOGIN", ip: "1.1.1.1" });
    const loginCode = code(e);
    await otp.request({ email: e, purpose: "STEP_UP", ip: "1.1.1.1", userId: randomUUID() });
    await expect(otp.verify(login.challengeId, loginCode)).resolves.toMatchObject({ purpose: "LOGIN" });
  });

  it("normalises the email: '  Foo@Bar.COM ' -> foo@bar.com", async () => {
    const local = `foo-${randomUUID()}`;
    const { challengeId } = await otp.request({ email: `  ${local}@Bar.COM `, purpose: "LOGIN", ip: "1.1.1.1" });
    const row = await prisma.otpChallenge.findUniqueOrThrow({ where: { id: challengeId } });
    expect(row.email).toBe(`${local}@bar.com`);
    expect(mail.send).toHaveBeenCalledWith("otp", `${local}@bar.com`, expect.objectContaining({ purpose: "LOGIN", expiresInMin: 10 }));
  });

  it("an unknown challenge id is OTP_INVALID", async () => {
    expect((await codeError(otp.verify(randomUUID(), "123456"))).code).toBe("OTP_INVALID");
  });

  it("expect.purpose / expect.userId mismatches are OTP_INVALID and burn no attempts", async () => {
    const e = email();
    const userId = randomUUID();
    const { challengeId } = await otp.request({ email: e, purpose: "STEP_UP", ip: "1.1.1.1", userId });
    expect((await codeError(otp.verify(challengeId, code(e), { purpose: "LOGIN" }))).code).toBe("OTP_INVALID");
    expect((await codeError(otp.verify(challengeId, code(e), { purpose: "STEP_UP", userId: randomUUID() }))).code).toBe("OTP_INVALID");
    expect((await prisma.otpChallenge.findUniqueOrThrow({ where: { id: challengeId } })).attempts).toBe(0);
    await expect(otp.verify(challengeId, code(e), { purpose: "STEP_UP", userId })).resolves.toMatchObject({ userId });
  });
});
