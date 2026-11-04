const init = jest.fn();
const captureException = jest.fn();
const setTag = jest.fn();

jest.mock("@sentry/nestjs", () => ({
  init: (...args: unknown[]) => init(...args),
  captureException: (...args: unknown[]) => captureException(...args),
  withScope: (fn: (scope: { setTag: typeof setTag }) => void) => fn({ setTag }),
}));

import { AppError } from "../errors/app-error";
import { initSentry, reportException, scrubSentryEvent } from "./sentry";

describe("sentry", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does not initialise without a DSN", () => {
    expect(initSentry({})).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it("initialises when a DSN is set", () => {
    expect(initSentry({ dsn: "https://k@o0.ingest.sentry.io/1", environment: "production" })).toBe(true);
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ dsn: "https://k@o0.ingest.sentry.io/1", environment: "production" }));
  });

  it("does not report AppError with a status below 500", () => {
    const err = new AppError("NOT_FOUND", 404, "nope");
    reportException(err, err.status);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("reports server errors with the request id tag", () => {
    const err = new AppError("INTERNAL", 500, "boom");
    reportException(err, err.status, { requestId: "req-1" });
    expect(captureException).toHaveBeenCalledWith(err);
    expect(setTag).toHaveBeenCalledWith("requestId", "req-1");
  });

  it("strips request data, cookies, headers and the query string but keeps method and path; scrubs sensitive extra/context keys", () => {
    const event = {
      request: { method: "PUT", url: "https://api.skiller.in/v1/wallet/payout-account?pan=ABCDE1234F", data: '{"pan":"ABCDE1234F"}', cookies: { a: "b" }, headers: { authorization: "Bearer x" }, query_string: "pan=ABCDE1234F" },
      extra: { accountNumber: "50100123456789", note: "ok", nested: { vpa: "a@b", keep: 1 } },
      contexts: { payout: { pan: "ABCDE1234F", token: "t", span_id: "abc" }, trace: { parent_span_id: "p", span_id: "s" } },
    };
    const out = scrubSentryEvent(event as never) as typeof event;
    expect(out.request).toEqual({ method: "PUT", url: "https://api.skiller.in/v1/wallet/payout-account" });
    expect(out.extra).toEqual({ accountNumber: "[Filtered]", note: "ok", nested: { vpa: "[Filtered]", keep: 1 } });
    expect(out.contexts).toEqual({ payout: { pan: "[Filtered]", token: "[Filtered]", span_id: "abc" }, trace: { parent_span_id: "p", span_id: "s" } });
  });

  it("initialises with no default PII collection and the scrubbing hook", () => {
    initSentry({ dsn: "https://k@o0.ingest.sentry.io/1" });
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ beforeSend: scrubSentryEvent, dataCollection: expect.objectContaining({ userInfo: false, httpBodies: [] }) }));
  });
});
