import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { v7 as uuidv7 } from "uuid";

const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & { id?: string }, res: Response, next: NextFunction) {
    const incoming = req.header("x-request-id");
    req.id = incoming && SAFE_ID.test(incoming) ? incoming : uuidv7();
    res.setHeader("x-request-id", req.id);
    next();
  }
}
