import * as Sentry from "@sentry/nestjs";

const SENSITIVE_KEY = /account|vpa|token|secret|password|(^|[^a-z])pan($|[^a-z])|^pan(?=[A-Z0-9])|(^|[^a-z])code($|[^a-z])|[a-z]Code$/i;
const FILTERED = "[Filtered]";

function scrubValue(value: unknown, depth: number): unknown {
  if (depth > 8 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? FILTERED : scrubValue(v, depth + 1);
  return out;
}

/**
 * Sentry's HTTP integration attaches the incoming request (body, cookies, headers, query string) to error events. Payout and KYC routes carry bank
 * account numbers and PANs in the body, so every event loses all of that: only the method and the URL path survive. `extra` and `contexts`
 * lose any value stored under an account / pan / vpa / token / code style key.
 */
export function scrubSentryEvent<T extends Sentry.ErrorEvent>(event: T): T {
  const req = event.request;
  if (req) {
    delete req.data;
    delete req.cookies;
    delete req.headers;
    delete req.query_string;
    if (typeof req.url === "string") req.url = req.url.split(/[?#]/)[0];
  }
  if (event.extra) event.extra = scrubValue(event.extra, 0) as typeof event.extra;
  if (event.contexts) event.contexts = scrubValue(event.contexts, 0) as typeof event.contexts;
  return event;
}

/** Initialises Sentry only when a DSN is configured; returns whether it is active. Call before the app is created. */
export function initSentry(opts: { dsn?: string; environment?: string; transport?: Sentry.NodeOptions["transport"] }): boolean {
  if (!opts.dsn) return false;
  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment,
    tracesSampleRate: 0,
    // `sendDefaultPii` no longer exists in SDK 11.10; `dataCollection` replaces it. `beforeSend` is the backstop that guarantees the result.
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, stackFrameVariables: false },
    beforeSend: scrubSentryEvent,
    ...(opts.transport ? { transport: opts.transport } : {}),
  });
  return true;
}

/**
 * Only server faults are reported. Client errors (AppError / HttpException / validation with status < 500) are expected
 * control flow and would just be noise.
 */
export function shouldReport(status: number): boolean {
  return status >= 500;
}

export function reportException(exception: unknown, status: number, context: { requestId?: string | null } = {}): void {
  if (!shouldReport(status)) return;
  Sentry.withScope((scope) => {
    if (context.requestId) scope.setTag("requestId", context.requestId);
    Sentry.captureException(exception);
  });
}
