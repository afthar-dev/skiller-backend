import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rewritePlaylist, withToken } from "../src/playlist";
import { verifyPlaybackToken } from "../src/token";
import vectors from "./vectors.json";

const OWNER = "0192f3a0-0000-7000-8000-0000000000c1";
const ASSET = vectors.valid[0].claims.a;
const OTHER_ASSET = "0192f3a0-0000-7000-8000-00000000000b";
const TOKEN = vectors.valid[0].token;
const BASE = "https://play.example.test";
const prefix = (asset: string) => `course_lesson/${OWNER}/${asset}`;
const get = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init));
const withT = (path: string, token = TOKEN) => `${path}?t=${token}`;

const MASTER = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360\n360p/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n720p/index.m3u8\n`;
const VARIANT = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k?id=1"\n#EXTINF:6.0,\nseg000.ts\n#EXTINF:6.0,\nseg001.ts?x=1\n#EXT-X-ENDLIST\n`;
const SEGMENT = new Uint8Array([0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

describe("playback gate", () => {
  beforeAll(async () => {
    const b = env.PRIVATE_BUCKET;
    await b.put(`${prefix(ASSET)}/hls/index.m3u8`, MASTER);
    await b.put(`${prefix(ASSET)}/hls/360p/index.m3u8`, VARIANT);
    await b.put(`${prefix(ASSET)}/hls/360p/seg000.ts`, SEGMENT);
    await b.put(`${prefix(ASSET)}/poster.jpg`, new Uint8Array([0xff, 0xd8, 0xff]));
    await b.put(`${prefix(OTHER_ASSET)}/hls/index.m3u8`, MASTER);
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(vectors.nowSec * 1000);
  });
  afterEach(() => vi.useRealTimers());

  describe("token verification (shared vectors)", () => {
    it.each(vectors.valid.map((v) => [v.name, v] as const))("accepts: %s", async (_n, v) => {
      expect(await verifyPlaybackToken(v.token, vectors.secret, vectors.nowSec)).toEqual(v.claims);
    });
    it.each(vectors.invalid.map((v) => [v.name, v.token] as const))("rejects: %s", async (_n, token) => {
      expect(await verifyPlaybackToken(token, vectors.secret, vectors.nowSec)).toBeNull();
    });
  });

  describe("playlist rewriting", () => {
    it("appends ?t= to every URI line and URI attribute, keeping existing queries", () => {
      const out = rewritePlaylist(VARIANT, "TOK").split("\n");
      expect(out).toContain('#EXT-X-MAP:URI="init.mp4?t=TOK"');
      expect(out).toContain("seg000.ts?t=TOK");
      expect(out).toContain("seg001.ts?x=1&t=TOK");
      // absolute URIs are never given the token
      expect(out).toContain('#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k?id=1"');
      expect(out).toContain("#EXTINF:6.0,");
    });
    it("handles CRLF, fragments and an existing t", () => {
      expect(rewritePlaylist("#EXTM3U\r\nseg.ts\r\n", "T")).toBe("#EXTM3U\r\nseg.ts?t=T\r\n");
      expect(withToken("a.ts?t=old&x=1#frag", "T")).toBe("a.ts?x=1&t=T#frag");
    });
  });

  describe("GET", () => {
    it("serves the master playlist rewritten, with playlist cache headers", async () => {
      const res = await get(withT(`/${prefix(ASSET)}/hls/index.m3u8`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
      expect(res.headers.get("cache-control")).toBe("private, max-age=60");
      const lines = (await res.text()).split("\n").filter((l) => l && !l.startsWith("#"));
      expect(lines).toEqual([`360p/index.m3u8?t=${TOKEN}`, `720p/index.m3u8?t=${TOKEN}`]);
      expect(lines.every((l) => l.endsWith(`?t=${TOKEN}`))).toBe(true);
    });

    it("serves variant playlists rewritten", async () => {
      const res = await get(withT(`/${prefix(ASSET)}/hls/360p/index.m3u8`));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain(`seg000.ts?t=${TOKEN}`);
      expect(text).toContain(`URI="init.mp4?t=${TOKEN}"`);
    });

    it("serves segments untouched with segment cache headers", async () => {
      const res = await get(withT(`/${prefix(ASSET)}/hls/360p/seg000.ts`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("video/mp2t");
      expect(res.headers.get("cache-control")).toBe("private, max-age=600");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(SEGMENT);
    });


    it("serves the poster", async () => {
      const res = await get(withT(`/${prefix(ASSET)}/poster.jpg`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
    });

    it("HEAD returns headers without a body", async () => {
      const res = await get(withT(`/${prefix(ASSET)}/hls/360p/seg000.ts`), { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
    });

    it("404s a valid token for a missing object", async () => {
      const res = await get(withT(`/${prefix(ASSET)}/hls/360p/seg999.ts`));
      expect(res.status).toBe(404);
    });
  });

  describe("layout / extension allow-list (valid token)", () => {
    it.each([
      ["a literal '..' inside a name", `/${prefix(ASSET)}/hls/a..b.m3u8`],
      ["a literal % inside a name", `/${prefix(ASSET)}/hls/a%b.m3u8`],
      ["source.mp4 under the asset prefix", `/${prefix(ASSET)}/source.mp4`],
      ["json under hls", `/${prefix(ASSET)}/hls/360p/x.json`],
      ["segment outside hls/", `/${prefix(ASSET)}/foo.ts`],
      ["playlist outside hls/", `/${prefix(ASSET)}/foo.m3u8`],
      ["poster.png", `/${prefix(ASSET)}/poster.png`],
      ["incoming source", `/incoming/${ASSET}/source.mp4`],
    ])("403: %s", async (_n, p) => {
      expect((await get(withT(p))).status).toBe(403);
    });

    it.each(["hls/x.m4s", "hls/x.mp4", "hls/360p/x.m4s", "hls/360p/x.mp4", "hls/360p/seg000.ts", "hls/index.m3u8", "poster.jpg"])("serves %s", async (rel) => {
      const key = `${prefix(ASSET)}/${rel}`;
      await env.PRIVATE_BUCKET.put(key, rel.endsWith("m3u8") ? MASTER : SEGMENT);
      expect((await get(withT(`/${key}`))).status).toBe(200);
    });
  });

  describe("byte ranges (segment is 10 bytes)", () => {
    const seg = `/${prefix(ASSET)}/hls/360p/seg000.ts`;
    const ranged = (range: string) => get(withT(seg), { headers: { Range: range } });
    const partial = async (range: string, start: number, end: number) => {
      const res = await ranged(range);
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(`bytes ${start}-${end}/10`);
      expect(res.headers.get("content-length")).toBe(String(end - start + 1));
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(SEGMENT.slice(start, end + 1));
    };
    it("a-b", () => partial("bytes=2-5", 2, 5));
    it("a-b clamps the end to the object", () => partial("bytes=7-99", 7, 9));
    it("open-ended a-", () => partial("bytes=4-", 4, 9));
    it("suffix -n", () => partial("bytes=-3", 7, 9));
    it("suffix larger than the object returns all of it", () => partial("bytes=-99", 0, 9));
    it.each(["bytes=10-", "bytes=10-12", "bytes=-0"])("416 for %s", async (range) => {
      const res = await ranged(range);
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe("bytes */10");
    });
    it.each(["bytes=abc", "bytes=5-2", "items=1-2", "bytes=1-2,4-5", "bytes=-"])("ignores malformed %s and serves 200 in full", async (range) => {
      const res = await ranged(range);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe("10");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(SEGMENT);
    });
  });

  describe("rejections", () => {
    const path = `/${prefix(ASSET)}/hls/index.m3u8`;

    it("403 without a token", async () => expect((await get(path)).status).toBe(403));
    it("403 with an empty token", async () => expect((await get(`${path}?t=`)).status).toBe(403));
    it("403 with a garbage token", async () => expect((await get(withT(path, "abc.def"))).status).toBe(403));
    it("403 with a tampered token", async () => expect((await get(withT(path, vectors.invalid[0].token))).status).toBe(403));
    it("403 with an expired token", async () => {
      const expired = vectors.invalid.find((v) => v.name === "expired")!;
      expect((await get(withT(path, expired.token))).status).toBe(403);
    });
    it("403 when the token is for another asset (asset A token on asset B path)", async () => {
      const res = await get(withT(`/${prefix(OTHER_ASSET)}/hls/index.m3u8`));
      expect(res.status).toBe(403);
    });
    it("403 for an oversized token", async () => {
      const big = vectors.invalid.find((v) => v.name.startsWith("oversized"))!;
      expect((await get(withT(path, big.token))).status).toBe(403);
    });

    it.each([
      ["double slash", `/${prefix(ASSET)}//hls/index.m3u8`],
      ["encoded dot segments", `/${prefix(ASSET)}/hls/%2e%2e/%2e%2e/${OTHER_ASSET}/hls/index.m3u8`],
      ["encoded slash", `/${prefix(ASSET)}/hls%2findex.m3u8`],
      ["literal dot segments to another asset", `/${prefix(ASSET)}/hls/../../${OTHER_ASSET}/hls/index.m3u8`],
      ["backslash dot segments to another asset", `/${prefix(ASSET)}/hls\\..\\..\\${OTHER_ASSET}/hls/index.m3u8`],
      ["unknown extension", `/${prefix(ASSET)}/hls/360p/seg000.php`],
      ["source file", `/incoming/${ASSET}/source`],
      ["wrong prefix", `/reel/${OWNER}/${ASSET}/hls/index.m3u8`],
      ["bare asset id", `/${ASSET}/hls/index.m3u8`],
      ["root", "/"],
    ])("403 for a path-traversal / off-layout path: %s", async (_n, p) => {
      const res = await get(withT(p));
      expect(res.status).toBe(403);
    });

    it.each(["POST", "PUT", "DELETE", "PATCH"])("405 for %s", async (method) => {
      const res = await get(withT(path), { method, body: method === "DELETE" ? undefined : "x" });
      expect(res.status).toBe(405);
    });
  });

  describe("CORS", () => {
    const path = withT(`/${prefix(ASSET)}/hls/index.m3u8`);
    it("echoes an allowed origin", async () => {
      const res = await get(path, { headers: { Origin: "https://app.skiller.in" } });
      expect(res.headers.get("access-control-allow-origin")).toBe("https://app.skiller.in");
      expect(res.headers.get("vary")).toContain("Origin");
    });
    it("omits CORS headers for other origins", async () => {
      const res = await get(path, { headers: { Origin: "https://evil.example" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
    it("also sets CORS on errors so players can read them", async () => {
      const res = await get(`/${prefix(ASSET)}/hls/index.m3u8`, { headers: { Origin: "https://app.skiller.in" } });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://app.skiller.in");
    });
  });
});
