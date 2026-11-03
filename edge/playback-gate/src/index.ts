import { rewritePlaylist } from "./playlist";
import { verifyPlaybackToken } from "./token";

export interface Env {
  PRIVATE_BUCKET: R2Bucket;
  PLAYBACK_SECRET: string;
  /** Comma-separated origins allowed to fetch playback assets from a browser (the API's CORS_ORIGINS). */
  ALLOWED_ORIGINS: string;
}

// Key layout written by the API's transcode job (src/modules/media/media.rules.ts `assetPrefix`):
//   course_lesson/{ownerId}/{assetId}/hls/index.m3u8            master playlist
//   course_lesson/{ownerId}/{assetId}/hls/{rung}/index.m3u8     variant playlist
//   course_lesson/{ownerId}/{assetId}/hls/{rung}/seg000.ts      segments
//   course_lesson/{ownerId}/{assetId}/poster.jpg
// The request path is the object key, so nothing is ever mapped or decoded.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NAME = "[A-Za-z0-9_-][A-Za-z0-9_.-]*";
const PATH = new RegExp(`^/course_lesson/(${UUID})/(${UUID})/(?:hls(?:/${NAME}){0,2}/${NAME}\\.(m3u8|ts|m4s|mp4)|poster\\.(jpg))$`, "i");

const CONTENT_TYPES: Record<string, string> = {
  m3u8: "application/vnd.apple.mpegurl",
  ts: "video/mp2t",
  m4s: "video/iso.segment",
  mp4: "video/mp4",
  jpg: "image/jpeg",
};

const PLAYLIST_CACHE = "private, max-age=60";
const SEGMENT_CACHE = "private, max-age=600";

function baseHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({ Vary: "Origin", "X-Content-Type-Options": "nosniff" });
  const origin = request.headers.get("Origin");
  if (origin && env.ALLOWED_ORIGINS.split(",").some((o) => o.trim() === origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, HEAD");
    headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, ETag");
  }
  return headers;
}

function fail(request: Request, env: Env, status: number, code: string): Response {
  const headers = baseHeaders(request, env);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json");
  if (status === 405) headers.set("Allow", "GET, HEAD");
  return new Response(JSON.stringify({ error: { code } }), { status, headers });
}

/** Single `bytes=` range. undefined = absent/malformed (serve everything); "unsatisfiable" = 416; else inclusive byte bounds. */
function resolveRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  if (m[1] === "") {
    const n = Number(m[2]);
    return n === 0 || size === 0 ? "unsatisfiable" : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== "" && Number(m[2]) < start) return undefined;
  if (start >= size) return "unsatisfiable";
  return { start, end: m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1) };
}

async function handle(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return fail(request, env, 405, "METHOD_NOT_ALLOWED");

  const url = new URL(request.url);
  // Strict allow-list on the exact path: rejects `//`, `%xx` escapes (incl. %2e%2e, %2f), `..`, unknown extensions and
  // anything outside the lesson layout. (The URL parser has already resolved literal dot segments.)
  const match = PATH.exec(url.pathname);
  if (!match || url.pathname.includes("..")) return fail(request, env, 403, "FORBIDDEN");
  const assetId = match[2];
  const ext = (match[3] ?? match[4]).toLowerCase();

  const token = url.searchParams.get("t") ?? "";
  const claims = await verifyPlaybackToken(token, env.PLAYBACK_SECRET, Math.floor(Date.now() / 1000));
  if (!claims || claims.a.toLowerCase() !== assetId.toLowerCase()) return fail(request, env, 403, "FORBIDDEN");

  const key = url.pathname.slice(1);
  const headers = baseHeaders(request, env);
  headers.set("Content-Type", CONTENT_TYPES[ext]);

  if (ext === "m3u8") {
    const object = await env.PRIVATE_BUCKET.get(key);
    if (!object) return fail(request, env, 404, "NOT_FOUND");
    headers.set("Cache-Control", PLAYLIST_CACHE);
    return new Response(rewritePlaylist(await object.text(), token), { status: 200, headers });
  }

  const head = await env.PRIVATE_BUCKET.head(key);
  if (!head) return fail(request, env, 404, "NOT_FOUND");
  const range = resolveRange(request.headers.get("Range"), head.size);
  if (range === "unsatisfiable") {
    const res = fail(request, env, 416, "RANGE_NOT_SATISFIABLE");
    res.headers.set("Content-Range", `bytes */${head.size}`);
    return res;
  }
  const object = await env.PRIVATE_BUCKET.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!object) return fail(request, env, 404, "NOT_FOUND");
  headers.set("Cache-Control", SEGMENT_CACHE);
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", object.httpEtag);
  let status = 200;
  let length = object.size;
  if (range) {
    status = 206;
    length = range.end - range.start + 1;
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${object.size}`);
  }
  headers.set("Content-Length", String(length));
  return new Response(object.body, { status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const res = await handle(request, env);
    return request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
  },
} satisfies ExportedHandler<Env>;
