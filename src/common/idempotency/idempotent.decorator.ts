import { applyDecorators, UseInterceptors } from "@nestjs/common";
import { IdempotencyInterceptor } from "./idempotency.interceptor";

/**
 * Marks a money-moving POST as idempotent. The client sends `Idempotency-Key`; the first request with a key runs, a repeat
 * with the same body gets the stored response back (header `Idempotent-Replayed: true`) for 24 hours. Authenticated routes only:
 * the key is scoped per user and per route.
 */
export const Idempotent = () => applyDecorators(UseInterceptors(IdempotencyInterceptor));
