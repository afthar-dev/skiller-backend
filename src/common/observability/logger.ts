import { v7 as uuidv7 } from "uuid";
import type { IncomingMessage } from "node:http";
import type { Params } from "nestjs-pino";
import type { AppConfig } from "../config/config.schema";

/** Paths pino replaces with "[Redacted]". `*.x` covers one nesting level (e.g. `body.code`, `req.body.token`). */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.code",
  "*.token",
  "*.refreshToken",
  "*.password",
  // Payout details (bank account number, UPI id, PAN): full values must never reach a log line, at the top level or up to three levels deep.
  ...["accountNumber", "account_number", "pan", "vpa"].flatMap((k) => [k, `*.${k}`, `*.*.${k}`, `*.*.*.${k}`]),
];

type RequestWithId = IncomingMessage & { id?: string };

// Same id rules as RequestIdMiddleware; pino-http runs first and stores the result as req.id for the middleware to reuse.
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;
export function resolveRequestId(req: IncomingMessage & { id?: unknown }): string {
  if (typeof req.id === "string" && req.id) return req.id;
  const incoming = req.headers["x-request-id"];
  return typeof incoming === "string" && SAFE_ID.test(incoming) ? incoming : uuidv7();
}

export function buildLoggerParams(config: Pick<AppConfig, "nodeEnv">): Params {
  return {
    pinoHttp: {
      level: config.nodeEnv === "test" ? "silent" : process.env.LOG_LEVEL ?? "info",
      redact: { paths: REDACT_PATHS, censor: "[Redacted]" },
      genReqId: (req: IncomingMessage) => resolveRequestId(req),
      customProps: (req: IncomingMessage) => ({ requestId: (req as RequestWithId).id }),
      // Health probes would drown real traffic.
      autoLogging: { ignore: (req: IncomingMessage) => /\/(health|ready)$/.test(req.url ?? "") },
      transport: config.nodeEnv === "development" ? { target: "pino-pretty", options: { singleLine: true, translateTime: "SYS:HH:MM:ss.l" } } : undefined,
    },
  };
}
