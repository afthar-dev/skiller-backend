import { CallHandler, ExecutionContext, Inject, Injectable, Logger, NestInterceptor } from "@nestjs/common";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import type { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { catchError, from, Observable, of, switchMap, throwError } from "rxjs";
import { v7 as uuidv7 } from "uuid";
import { CLOCK, type Clock } from "../clock/clock";
import { AppError } from "../errors/app-error";
import { describeError } from "../errors/error.filter";
import { PrismaService } from "../prisma/prisma.service";
import { stableStringify } from "./stable-json";

export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
/** An IN_PROGRESS record older than this belongs to a crashed attempt and may be taken over. Longer than any gateway call timeout. */
export const IDEMPOTENCY_STALE_MS = 2 * 60 * 1000;
const MAX_KEY_LENGTH = 255;

type Decision =
  | { kind: "run"; id: string; startedAt: Date }
  | { kind: "replay"; statusCode: number; response: unknown };

interface Stored {
  id: string;
  requestHash: string;
  status: "IN_PROGRESS" | "COMPLETED";
  statusCode: number | null;
  response: Prisma.JsonValue | null;
  startedAt: Date;
}

/**
 * Idempotency for money-moving POSTs (see @Idempotent). One row per (user, route, key), claimed with INSERT .. ON CONFLICT DO
 * NOTHING so only one concurrent request runs:
 *   - same key, same body, finished      -> the stored status and body again, header `Idempotent-Replayed: true`
 *   - same key, same body, still running -> 409 IDEMPOTENCY_IN_PROGRESS
 *   - same key, other body               -> 409 IDEMPOTENCY_KEY_REUSED
 *   - 2xx and 4xx outcomes are stored; a 5xx releases the key so the client's retry runs again
 * A request that crashed mid-flight leaves IN_PROGRESS behind; after IDEMPOTENCY_STALE_MS the next attempt takes it over
 * (compare-and-set on startedAt, so a slow original can no longer overwrite the new attempt's result).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: { id: string } }>();
    const res = http.getResponse<Response>();
    const successStatus: number = Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler()) ?? (req.method === "POST" ? 201 : 200);

    return from(this.begin(req)).pipe(
      switchMap((decision) => {
        if (decision.kind === "replay") {
          res.setHeader("Idempotent-Replayed", "true");
          if (decision.statusCode >= 400) {
            const e = decision.response as { code: string; message: string; details?: Record<string, unknown> };
            return throwError(() => new AppError(e.code, decision.statusCode, e.message, e.details ?? {}));
          }
          return of(decision.response);
        }
        return next.handle().pipe(
          switchMap((body) => from(this.complete(decision, successStatus, body ?? null)).pipe(switchMap(() => of(body)))),
          catchError((err: unknown) => from(this.fail(decision, err)).pipe(switchMap(() => throwError(() => err)))),
        );
      }),
    );
  }

  private async begin(req: Request & { user?: { id: string } }): Promise<Decision> {
    const key = (req.headers["idempotency-key"] as string | undefined)?.trim();
    if (!key) throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400, "The Idempotency-Key header is required");
    if (key.length > MAX_KEY_LENGTH) throw new AppError("IDEMPOTENCY_KEY_INVALID", 400, `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`);
    const userId = req.user?.id;
    if (!userId) throw new AppError("IDEMPOTENCY_REQUIRES_AUTH", 500, "@Idempotent() is only valid on authenticated routes");

    const route = `${req.method} ${req.originalUrl.split("?")[0]}`;
    const requestHash = createHash("sha256").update(stableStringify(req.body ?? null)).digest("hex");

    for (let attempt = 0; attempt < 3; attempt++) {
      const now = this.clock.now();
      const inserted = await this.prisma.$queryRaw<{ id: string }[]>`INSERT INTO idempotency_records ("id", "userId", "route", "key", "requestHash", "status", "startedAt", "createdAt")
        VALUES (${uuidv7()}, ${userId}, ${route}, ${key}, ${requestHash}, 'IN_PROGRESS'::"IdempotencyStatus", ${now}, ${now})
        ON CONFLICT ("userId", "route", "key") DO NOTHING
        RETURNING "id"`;
      if (inserted.length === 1) return { kind: "run", id: inserted[0].id, startedAt: now };

      const existing = (await this.prisma.idempotencyRecord.findUnique({ where: { userId_route_key: { userId, route, key } } })) as Stored | null;
      if (!existing) continue; // released between our insert and our read: claim it
      if (existing.requestHash !== requestHash) {
        throw new AppError("IDEMPOTENCY_KEY_REUSED", 409, "This Idempotency-Key was already used with a different request body");
      }
      if (existing.status === "COMPLETED") return { kind: "replay", statusCode: existing.statusCode ?? 200, response: existing.response };
      if (now.getTime() - existing.startedAt.getTime() >= IDEMPOTENCY_STALE_MS) {
        const taken = await this.prisma.idempotencyRecord.updateMany({ where: { id: existing.id, status: "IN_PROGRESS", startedAt: existing.startedAt }, data: { startedAt: now } });
        if (taken.count === 1) return { kind: "run", id: existing.id, startedAt: now };
      }
      throw new AppError("IDEMPOTENCY_IN_PROGRESS", 409, "A request with this Idempotency-Key is still being processed");
    }
    throw new AppError("IDEMPOTENCY_IN_PROGRESS", 409, "A request with this Idempotency-Key is still being processed");
  }

  private async complete(decision: Extract<Decision, { kind: "run" }>, statusCode: number, body: unknown): Promise<void> {
    let response: Prisma.InputJsonValue;
    try {
      response = JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue;
    } catch (err) {
      await this.release(decision);
      throw err;
    }
    await this.finish(decision, statusCode, response);
  }

  private async fail(decision: Extract<Decision, { kind: "run" }>, err: unknown): Promise<void> {
    const [status, error] = describeError(err, true);
    if (status >= 500) {
      await this.release(decision);
      return;
    }
    await this.finish(decision, status, error as unknown as Prisma.InputJsonValue);
  }

  /** Marks the record COMPLETED. A failure here must not turn a request that already did its work into an error. */
  private async finish(decision: Extract<Decision, { kind: "run" }>, statusCode: number, response: Prisma.InputJsonValue): Promise<void> {
    try {
      await this.prisma.idempotencyRecord.updateMany({
        where: { id: decision.id, status: "IN_PROGRESS", startedAt: decision.startedAt },
        data: { status: "COMPLETED", statusCode, response },
      });
    } catch (err) {
      this.logger.error(`could not store idempotent response for record ${decision.id}: ${(err as Error).message}`);
    }
  }

  /** Frees the key (failure we do not want to replay) so the client's retry runs again. */
  private async release(decision: Extract<Decision, { kind: "run" }>): Promise<void> {
    try {
      await this.prisma.idempotencyRecord.deleteMany({ where: { id: decision.id, status: "IN_PROGRESS", startedAt: decision.startedAt } });
    } catch (err) {
      this.logger.error(`could not release idempotency record ${decision.id}: ${(err as Error).message}`);
    }
  }
}

