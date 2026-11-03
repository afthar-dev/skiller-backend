import type { NextFunction, Request, Response } from "express";

/**
 * Reads the body of POSTs to the given paths as raw bytes (req.rawBody) before Nest's JSON parser sees them, and marks the
 * body as already parsed. Webhook routes verify a signature over those bytes and answer malformed JSON themselves instead of
 * having the parser reject it first.
 */
export function captureRawBody(paths: string[], limitBytes = 1024 * 1024) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST" || !paths.includes(req.path)) return next();
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limitBytes) {
        aborted = true;
        res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large", details: {} }, requestId: (req as { id?: string }).id ?? null });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      (req as Request & { rawBody?: Buffer; _body?: boolean }).rawBody = Buffer.concat(chunks);
      (req as { _body?: boolean })._body = true; // body-parser skips requests that are already parsed
      req.body = {};
      next();
    });
    req.on("error", next);
  };
}
