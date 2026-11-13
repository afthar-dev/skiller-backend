import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkResponses } from "./check-openapi-responses-lib.mjs";

const json = (schema) => ({ content: { "application/json": { schema } } });
const doc = {
  paths: {
    "/typed": { get: { responses: { 200: json({ type: "object", properties: { a: { type: "string" } } }) } } },
    "/ref": { get: { responses: { 200: json({ $ref: "#/components/schemas/X" }) } } },
    "/empty-schema": { get: { responses: { 200: json({}) } } },
    "/placeholder": { get: { responses: { 200: json({ type: "object" }) } } },
    "/array": { get: { responses: { 200: json({ type: "array", items: { type: "string" } }) } } },
    "/no-content": { post: { responses: { 201: { description: "Created" } } } },
    "/stream": { get: { responses: { 200: { content: { "text/event-stream": { schema: { type: "string" } } } } } } },
    "/csv": { get: { responses: { 200: { content: { "text/csv": { schema: { type: "string" } } } } } } },
    "/gone": { delete: { responses: { 204: { description: "No content" } } } },
    "/error-only": { get: { responses: { 200: { description: "ok" }, 400: json({ type: "object", properties: { e: {} } }) } } },
  },
};

test("typed operations need no allowlist entry", () => {
  const problems = checkResponses(doc, ["GET /empty-schema", "GET /placeholder", "POST /no-content", "GET /error-only"]);
  assert.deepEqual(problems, []);
});

test("an untyped operation outside the allowlist is reported by name", () => {
  const problems = checkResponses(doc, ["GET /empty-schema", "GET /placeholder", "POST /no-content"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /GET \/error-only/);
});

test("an allowlist entry that is now typed is reported", () => {
  const problems = checkResponses(doc, ["GET /empty-schema", "GET /placeholder", "POST /no-content", "GET /error-only", "GET /typed", "DELETE /gone"]);
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /GET \/typed/);
  assert.match(problems.join("\n"), /DELETE \/gone/);
});

test("an allowlist entry for a removed operation is reported", () => {
  const problems = checkResponses(doc, ["GET /empty-schema", "GET /placeholder", "POST /no-content", "GET /error-only", "GET /missing"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /GET \/missing/);
});

test("the CLI exits 1 naming the operation, and 0 when they agree", () => {
  const dir = mkdtempSync(join(tmpdir(), "openapi-check-"));
  const spec = join(dir, "openapi.json");
  const list = join(dir, "allowlist.json");
  writeFileSync(spec, JSON.stringify(doc));
  const script = join(dirname(fileURLToPath(import.meta.url)), "check-openapi-responses.mjs");
  const ceiling = join(dir, "ceiling.json");
  writeFileSync(ceiling, JSON.stringify({ max: 3 }));
  writeFileSync(list, JSON.stringify(["GET /empty-schema", "GET /placeholder", "POST /no-content"]));
  const bad = spawnSync(process.execPath, [script, "--openapi", spec, "--allowlist", list, "--ceiling", ceiling], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /GET \/error-only/);
  writeFileSync(list, JSON.stringify(["GET /empty-schema", "GET /placeholder", "POST /no-content", "GET /error-only"]));
  writeFileSync(ceiling, JSON.stringify({ max: 4 }));
  const good = spawnSync(process.execPath, [script, "--openapi", spec, "--allowlist", list, "--ceiling", ceiling], { encoding: "utf8" });
  assert.equal(good.status, 0);
});

test("a bare { type: \"object\" } placeholder does not count as typed", () => {
  assert.deepEqual(checkResponses(doc, ["GET /empty-schema", "POST /no-content", "GET /error-only"]).length, 1);
  assert.match(checkResponses(doc, ["GET /empty-schema", "POST /no-content", "GET /error-only"])[0], /GET [/]placeholder/);
});

test("the allowlist cannot grow past its ceiling, and the ceiling must fall with it", () => {
  const list = ["GET /empty-schema", "GET /placeholder", "POST /no-content", "GET /error-only"];
  assert.deepEqual(checkResponses(doc, list, 4), []);
  assert.match(checkResponses(doc, list, 3).join(" "), /over its ceiling of 3/);
  assert.match(checkResponses(doc, list, 5).join(" "), /lower the ceiling from 5 to 4/);
});

test("the CLI still checks when started through a symlink", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "openapi-check-link-"));
  const real = join(dirname(fileURLToPath(import.meta.url)), "check-openapi-responses.mjs");
  const link = join(dir, "link.mjs");
  try {
    symlinkSync(real, link);
  } catch {
    t.skip("symlinks are not available here");
    return;
  }
  const spec = join(dir, "openapi.json");
  const list = join(dir, "allowlist.json");
  const ceiling = join(dir, "ceiling.json");
  writeFileSync(spec, JSON.stringify(doc));
  writeFileSync(list, JSON.stringify([]));
  writeFileSync(ceiling, JSON.stringify({ max: 0 }));
  const res = spawnSync(process.execPath, [link, "--openapi", spec, "--allowlist", list, "--ceiling", ceiling], { encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /GET [/]placeholder/);
});

test("a text/csv response with a described schema counts as typed; one without does not", () => {
  assert.deepEqual(checkResponses(doc, ["GET /empty-schema", "GET /placeholder", "POST /no-content", "GET /error-only"]), []);
  assert.match(checkResponses(doc, ["GET /empty-schema", "GET /placeholder", "POST /no-content", "GET /error-only", "GET /csv"]).join(" "), /allowlist entry is now typed.*GET \/csv/);
  const bare = { paths: { "/csv": { get: { responses: { 200: { content: { "text/csv": {} } } } } } } };
  assert.match(checkResponses(bare, []).join(" "), /untyped operation not in the allowlist: GET \/csv/);
});
