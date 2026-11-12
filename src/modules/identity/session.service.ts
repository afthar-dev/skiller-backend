import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Session } from "@prisma/client";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { v7 as uuidv7 } from "uuid";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { REDIS } from "../../common/redis/redis.constants";

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** A stale refresh token presented this soon after rotation is a concurrent request, not theft. */
export const REFRESH_RACE_WINDOW_MS = 10_000;
/** Matches the access token lifetime: after this a revoked session's tokens are expired anyway. */
export const REVOKED_KEY_TTL_SEC = 16 * 60;
const MARKER_ATTEMPTS = 3;
/** Redis TTL of a grace entry; the DB rotatedAt check is what enforces the exact 10 s window. */
const GRACE_KEY_TTL_SEC = 12;

// Ops: Redis must run with maxmemory-policy noeviction (see README); an evicted marker would re-enable a revoked access token.

export interface SessionMeta {
  ip: string;
  userAgent: string;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const newRefreshToken = () => randomBytes(32).toString("base64url");
const revokedKey = (sessionId: string) => `sessions:revoked:${sessionId}`;
const graceKey = (oldHash: string) => `sessions:grace:${oldHash}`;
/** Key derived from the OLD token: Redis holds only ciphertext that just the holder of that token can open. */
const graceKeyFor = (oldToken: string) => createHash("sha256").update(`refresh-grace:${oldToken}`).digest();
const sealGrace = (oldToken: string, newToken: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", graceKeyFor(oldToken), iv);
  const body = Buffer.concat([cipher.update(newToken, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
};
const openGrace = (oldToken: string, sealed: string): string | null => {
  try {
    const raw = Buffer.from(sealed, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", graceKeyFor(oldToken), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
};
const clip = (userAgent: string) => userAgent.slice(0, 512);

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(userId: string, meta: SessionMeta): Promise<{ session: Session; refreshToken: string }> {
    const now = this.clock.now();
    const refreshToken = newRefreshToken();
    const session = await this.prisma.session.create({
      data: {
        userId,
        familyId: uuidv7(),
        refreshHash: sha256(refreshToken),
        userAgent: clip(meta.userAgent),
        ip: meta.ip,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
        createdAt: now,
      },
    });
    return { session, refreshToken };
  }

  async rotate(refreshToken: string, meta: SessionMeta): Promise<{ userId: string; sessionId: string; refreshToken: string }> {
    return this.rotateOnce(refreshToken, meta, true);
  }

  private async rotateOnce(
    refreshToken: string,
    meta: SessionMeta,
    mayRetry: boolean,
  ): Promise<{ userId: string; sessionId: string; refreshToken: string }> {
    const hash = sha256(refreshToken);
    const now = this.clock.now();

    const current = await this.prisma.session.findUnique({ where: { refreshHash: hash } });
    if (current) {
      if (current.revokedAt || current.expiresAt <= now) throw this.sessionExpired();
      const next = newRefreshToken();
      // Compare-and-swap on the presented hash: of any number of concurrent rotations exactly one wins.
      const won = await this.prisma.session.updateMany({
        where: { id: current.id, refreshHash: hash, revokedAt: null },
        data: {
          previousHash: hash,
          refreshHash: sha256(next),
          rotatedAt: now,
          lastUsedAt: now,
          expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
          ip: meta.ip,
          userAgent: clip(meta.userAgent),
        },
      });
      if (won.count === 1) {
        await this.storeGrace(refreshToken, hash, next);
        return { userId: current.userId, sessionId: current.id, refreshToken: next };
      }
      // Lost the race (or the session was revoked meanwhile): re-evaluate, now via previousHash.
      if (mayRetry) return this.rotateOnce(refreshToken, meta, false);
      throw this.sessionExpired();
    }

    const stale = await this.prisma.session.findUnique({ where: { previousHash: hash } });
    if (stale) {
      if (stale.rotatedAt && now.getTime() - stale.rotatedAt.getTime() <= REFRESH_RACE_WINDOW_MS) {
        // Idempotent rotation: a response lost on the way is retried with the old cookie; hand back the token already issued.
        if (stale.revokedAt || stale.expiresAt <= now) throw this.sessionExpired();
        const replay = await this.replayGrace(refreshToken, hash, stale.refreshHash);
        if (replay) return { userId: stale.userId, sessionId: stale.id, refreshToken: replay };
        throw new AppError("REFRESH_RACE", 409, "Refresh already in progress; retry with the newest cookie");
      }
      await this.revokeFamily(stale.familyId, now);
      throw new AppError("AUTH_TOKEN_REUSED", 401, "Refresh token reuse detected; please sign in again");
    }

    throw this.sessionExpired();
  }

  private async storeGrace(oldToken: string, oldHash: string, newToken: string): Promise<void> {
    try {
      await this.redis.set(graceKey(oldHash), sealGrace(oldToken, newToken), "EX", GRACE_KEY_TTL_SEC);
    } catch (err) {
      // Without the entry a lost response degrades to the old 409 path; rotation itself must not fail.
      this.logger.warn(`could not store refresh grace entry: ${(err as Error).message}`);
    }
  }

  private async replayGrace(oldToken: string, oldHash: string, currentHash: string): Promise<string | null> {
    let sealed: string | null;
    try {
      sealed = await this.redis.get(graceKey(oldHash));
    } catch {
      return null;
    }
    if (!sealed) return null;
    const token = openGrace(oldToken, sealed);
    return token && sha256(token) === currentHash ? token : null;
  }

  /** Revokes a session. With `ownerId`, only a session of that user; returns false if there is no such session. */
  async revoke(sessionId: string, ownerId?: string): Promise<boolean> {
    const row = await this.prisma.session.findFirst({ where: { id: sessionId, ...(ownerId ? { userId: ownerId } : {}) } });
    if (!row) return false;
    // Marker first: if it cannot be written the session stays fully active and the caller can retry.
    await this.markRevokedOrFail([sessionId]);
    await this.prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: this.clock.now() } });
    return true;
  }

  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<void> {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return;
    await this.markRevokedOrFail(ids);
    await this.prisma.session.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: this.clock.now() } });
  }

  list(userId: string): Promise<Session[]> {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: this.clock.now() } },
      orderBy: { lastUsedAt: "desc" },
    });
  }

  async countActive(userId: string): Promise<number> {
    return this.prisma.session.count({ where: { userId, revokedAt: null, expiresAt: { gt: this.clock.now() } } });
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    return (await this.redis.exists(revokedKey(sessionId))) === 1;
  }

  private async revokeFamily(familyId: string, now: Date): Promise<void> {
    const rows = await this.prisma.session.findMany({ where: { familyId }, select: { id: true } });
    // Theft response: best effort on the marker, never let a Redis outage change the 401 or skip the DB revocation.
    await this.markRevokedOrFail(rows.map((r) => r.id)).catch((err: unknown) =>
      this.logger.error(`could not write revocation markers for family ${familyId}: ${(err as Error).message}`),
    );
    await this.prisma.session.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });
  }

  private async markRevokedOrFail(ids: string[]): Promise<void> {
    try {
      await Promise.all(ids.map((id) => this.setMarker(id)));
    } catch {
      throw new AppError("SERVICE_UNAVAILABLE", 503, "Temporarily unable to revoke the session; please retry");
    }
  }

  private async setMarker(sessionId: string): Promise<void> {
    let last: unknown;
    for (let attempt = 1; attempt <= MARKER_ATTEMPTS; attempt++) {
      try {
        await this.redis.set(revokedKey(sessionId), "1", "EX", REVOKED_KEY_TTL_SEC);
        return;
      } catch (err) {
        last = err;
        if (attempt < MARKER_ATTEMPTS) await new Promise((r) => setTimeout(r, 25 * attempt));
      }
    }
    throw last;
  }

  private sessionExpired() {
    return new AppError("AUTH_SESSION_EXPIRED", 401, "Session expired; please sign in again");
  }
}
