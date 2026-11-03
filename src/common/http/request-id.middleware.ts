import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { resolveRequestId } from "../observability/logger";

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & { id?: string }, res: Response, next: NextFunction) {
    req.id = resolveRequestId(req);
    res.setHeader("x-request-id", req.id);
    next();
  }
}
