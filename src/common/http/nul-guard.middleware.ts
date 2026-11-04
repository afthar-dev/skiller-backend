import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/app-error";

const NUL = "\u0000";
const MAX_DEPTH = 32;

/** True when any string in the value (keys included) holds U+0000, which Postgres text cannot store. */
function hasNul(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value.includes(NUL);
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => hasNul(v, depth + 1));
  return Object.entries(value).some(([k, v]) => k.includes(NUL) || hasNul(v, depth + 1));
}

function decodedPath(req: Request): string {
  try {
    return decodeURIComponent(req.originalUrl.split("?")[0]);
  } catch {
    return req.originalUrl;
  }
}

/** A NUL byte in the query string, the path or a JSON body is never valid input and would reach the database as a driver error (500): answer 400 first. */
@Injectable()
export class NulGuardMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    if (decodedPath(req).includes(NUL) || hasNul(req.query) || hasNul(req.body)) {
      throw new AppError("VALIDATION_FAILED", 400, "Request validation failed", { reason: "NUL characters are not allowed" });
    }
    next();
  }
}
