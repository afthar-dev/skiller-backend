import * as Sentry from "@sentry/nestjs";

/** Initialises Sentry only when a DSN is configured; returns whether it is active. Call before the app is created. */
export function initSentry(opts: { dsn?: string; environment?: string }): boolean {
  if (!opts.dsn) return false;
  Sentry.init({ dsn: opts.dsn, environment: opts.environment, tracesSampleRate: 0 });
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
