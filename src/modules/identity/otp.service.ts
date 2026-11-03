import { Inject, Injectable } from "@nestjs/common";
import { OtpPurpose, Prisma } from "@prisma/client";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { MailService } from "../mail";

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

export interface OtpRequestInput {
  email: string;
  purpose: OtpPurpose;
  ip: string;
  userId?: string;
}

export interface OtpVerifyResult {
  email: string;
  purpose: OtpPurpose;
  userId?: string;
}

/** Extra bindings enforced inside the single UPDATE, so a mismatch never consumes an attempt or the challenge. */
export interface OtpVerifyExpectation {
  purpose?: OtpPurpose;
  userId?: string;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

interface ChallengeRow {
  id: string;
  email: string;
  purpose: OtpPurpose;
  userId: string | null;
  codeHash: string;
  attempts: number;
}

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async request(input: OtpRequestInput): Promise<{ challengeId: string; expiresAt: Date }> {
    const email = normalizeEmail(input.email);
    const now = this.clock.now();
    const challengeId = uuidv7();
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS);

    await this.prisma.$transaction(async (tx) => {
      // Only the newest challenge for an email+purpose may be redeemed.
      await tx.otpChallenge.updateMany({
        where: { email, purpose: input.purpose, consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.otpChallenge.create({
        data: {
          id: challengeId,
          email,
          purpose: input.purpose,
          userId: input.userId ?? null,
          codeHash: this.hash(challengeId, code),
          expiresAt,
          ip: input.ip,
          createdAt: now,
        },
      });
    });

    await this.mail.send("otp", email, { code, purpose: input.purpose, expiresInMin: 10 });
    return { challengeId, expiresAt };
  }

  async verify(challengeId: string, code: string, expect: OtpVerifyExpectation = {}): Promise<OtpVerifyResult> {
    const now = this.clock.now();
    const purposeFilter = expect.purpose ? Prisma.sql`AND "purpose" = ${expect.purpose}::"OtpPurpose"` : Prisma.empty;
    const userFilter = expect.userId ? Prisma.sql`AND "userId" = ${expect.userId}` : Prisma.empty;

    // One statement: the attempt is counted atomically and only while the challenge is live and under the cap.
    const rows = await this.prisma.$queryRaw<ChallengeRow[]>(Prisma.sql`
      UPDATE "otp_challenges"
      SET "attempts" = "attempts" + 1
      WHERE "id" = ${challengeId}
        AND "consumedAt" IS NULL
        AND "expiresAt" > ${now}
        AND "attempts" < ${OTP_MAX_ATTEMPTS}
        ${purposeFilter}
        ${userFilter}
      RETURNING "id", "email", "purpose", "userId", "codeHash", "attempts"
    `);

    const row = rows[0];
    if (!row) throw await this.explainRejection(challengeId, now, expect);

    const expected = Buffer.from(row.codeHash, "hex");
    const actual = Buffer.from(this.hash(row.id, code), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new AppError("OTP_INVALID", 400, "Invalid code", { attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - row.attempts) });
    }

    const consumed = await this.prisma.otpChallenge.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (consumed.count === 0) throw new AppError("OTP_INVALID", 400, "Invalid code", { attemptsLeft: 0 });

    return { email: row.email, purpose: row.purpose, userId: row.userId ?? undefined };
  }

  private async explainRejection(challengeId: string, now: Date, expect: OtpVerifyExpectation): Promise<AppError> {
    const invalid = () => new AppError("OTP_INVALID", 400, "Invalid code", { attemptsLeft: 0 });
    const row = await this.prisma.otpChallenge.findUnique({ where: { id: challengeId } });
    if (!row || row.consumedAt) return invalid();
    if (expect.purpose && row.purpose !== expect.purpose) return invalid();
    if (expect.userId && row.userId !== expect.userId) return invalid();
    if (row.expiresAt <= now) return new AppError("OTP_EXPIRED", 400, "Code expired");
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      return new AppError("OTP_LOCKED", 429, "Too many attempts; request a new code");
    }
    return invalid();
  }

  private hash(challengeId: string, code: string): string {
    return createHmac("sha256", this.config.otpPepper).update(`${challengeId}:${code}`).digest("hex");
  }
}
