import { ArgumentsHost, HttpException, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AppError } from "./app-error";
import { ErrorFilter } from "./error.filter";

function run(filter: ErrorFilter, error: unknown) {
  const res = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const response = {
    status(code: number) {
      res.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    json(body: unknown) {
      res.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ id: "req-123" }) }),
  } as unknown as ArgumentsHost;
  filter.catch(error, host);
  return res;
}

describe("ErrorFilter", () => {
  it("maps AppError to the shared error body", () => {
    const res = run(new ErrorFilter(false), new AppError("COURSE_NOT_FOUND", 404, "Course not found"));
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      error: { code: "COURSE_NOT_FOUND", message: "Course not found", details: {} },
      requestId: "req-123",
    });
  });

  it("hides unknown error messages in production", () => {
    const res = run(new ErrorFilter(true), new Error("db exploded"));
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: { code: "INTERNAL", message: "Something went wrong" } });
  });

  it("maps zod errors to VALIDATION_FAILED with field details", () => {
    const parsed = z.object({ email: z.string().email() }).safeParse({ email: "nope" });
    const res = run(new ErrorFilter(false), (parsed as { error: z.ZodError }).error);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "VALIDATION_FAILED", details: { fields: { email: expect.any(Array) } } } });
  });

  it("maps prisma unique violations to CONFLICT", () => {
    const error = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6" });
    const res = run(new ErrorFilter(false), error);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("maps Nest HttpException using its status", () => {
    const res = run(new ErrorFilter(false), new HttpException("Not here", HttpStatus.NOT_FOUND));
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "NOT_FOUND", message: "Not here" } });
  });

  it("sets Retry-After when details carry retryAfterSec", () => {
    const res = run(new ErrorFilter(false), new AppError("RATE_LIMITED", 429, "Slow down", { retryAfterSec: 12 }));
    expect(res.headers["Retry-After"]).toBe("12");
  });
});
