import { SetMetadata } from "@nestjs/common";
import type { Request } from "express";

export interface RateLimitOptions {
  key: (req: Request) => string;
  limit: number;
  windowSec: number;
}

export const RATE_LIMIT_KEY = "skiller:rate-limit";

/** One or more independent limits; the request is rejected if any of them is exhausted. */
export const RateLimit = (...options: RateLimitOptions[]) => SetMetadata(RATE_LIMIT_KEY, options);
