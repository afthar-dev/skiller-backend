import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** Added by the Cloudflare proxy (a Transform Rule "Set request header"); compared with ORIGIN_SHARED_SECRET. */
export const ORIGIN_SECRET_HEADER = "x-skiller-origin";

/** Probed by the hosting platform straight at the origin, so it cannot carry the proxy's header. */
const OPEN_PATHS = new Set(["/v1/health", "/v1/ready"]);

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * With ORIGIN_SHARED_SECRET set, only requests that went through the Cloudflare proxy are served. A request made straight at the
 * platform hostname (for example skiller-api.onrender.com) lacks the header and gets 403, so it cannot spoof X-Forwarded-For
 * past the extra trusted hop. Without a secret this does nothing.
 */
export function originGuard(secret: string | undefined) {
  const expected = secret ? digest(secret) : undefined;
  return (req: Request, res: Response, next: NextFunction) => {
    if (!expected || OPEN_PATHS.has(req.path)) return next();
    const sent = req.headers?.[ORIGIN_SECRET_HEADER];
    if (typeof sent === "string" && sent.length > 0 && timingSafeEqual(digest(sent), expected)) return next();
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Direct access is not allowed", details: {} }, requestId: (req as { id?: string }).id ?? null });
  };
}
