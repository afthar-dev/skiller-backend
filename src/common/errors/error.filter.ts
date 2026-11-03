import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { reportException } from "../observability/sentry";
import { AppError } from "./app-error";

interface ErrorBody {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

const STATUS_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: "UNPROCESSABLE",
  429: "RATE_LIMITED",
};

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  constructor(private readonly isProduction: boolean) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const response = http.getResponse();
    const request = http.getRequest();
    const [status, error] = this.toError(exception);

    if (status >= 500) this.logger.error(exception);
    reportException(exception, status, { requestId: request.id });
    const retryAfter = error.details.retryAfterSec;
    if (typeof retryAfter === "number") response.setHeader("Retry-After", String(retryAfter));

    response.status(status).json({ error, requestId: request.id ?? null });
  }

  private toError(exception: unknown): [number, ErrorBody] {
    if (exception instanceof AppError) {
      return [exception.status, { code: exception.code, message: exception.message, details: exception.details }];
    }
    if (exception instanceof ZodError) {
      const fields = exception.flatten().fieldErrors;
      return [400, { code: "VALIDATION_FAILED", message: "Request validation failed", details: { fields } }];
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === "P2002") {
      return [409, { code: "CONFLICT", message: "Resource already exists", details: { target: exception.meta?.target ?? null } }];
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const message = typeof res === "string" ? res : ((res as { message?: unknown }).message ?? exception.message);
      return [
        status,
        {
          code: STATUS_CODES[status] ?? (status >= 500 ? "INTERNAL" : "ERROR"),
          message: Array.isArray(message) ? message.join("; ") : String(message),
          details: {},
        },
      ];
    }
    const message = this.isProduction ? "Something went wrong" : (exception as Error)?.message ?? "Something went wrong";
    return [HttpStatus.INTERNAL_SERVER_ERROR, { code: "INTERNAL", message, details: {} }];
  }
}
