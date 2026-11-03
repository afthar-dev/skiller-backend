const init = jest.fn();
const captureException = jest.fn();
const setTag = jest.fn();

jest.mock("@sentry/nestjs", () => ({
  init: (...args: unknown[]) => init(...args),
  captureException: (...args: unknown[]) => captureException(...args),
  withScope: (fn: (scope: { setTag: typeof setTag }) => void) => fn({ setTag }),
}));

import { AppError } from "../errors/app-error";
import { initSentry, reportException } from "./sentry";

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
});
