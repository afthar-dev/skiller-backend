import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkResponses } from "./check-openapi-responses.mjs";

const json = (schema) => ({ content: { "application/json": { schema } } });
const doc = {
  paths: {
    "/typed": { get: { responses: { 200: json({ type: "object", properties: { a: { type: "string" } } }) } } },
    "/ref": { get: { responses: { 200: json({ $ref: "#/components/schemas/X" }) } } },
    "/empty-schema": { get: { responses: { 200: json({}) } } },
    "/no-content": { post: { responses: { 201: { description: "Created" } } } },
    "/gone": { delete: { responses: { 204: { description: "No content" } } } },
    "/error-only": { get: { responses: { 200: { description: "ok" }, 400: json({ type: "object", properties: { e: {} } }) } } },
  },
};

test("typed operations need no allowlist entry", () => {
  const problems = checkResponses(doc, ["GET /empty-schema", "POST /no-content", "GET /error-only"]);
  assert.deepEqual(problems, []);
});

test("an untyped operation outside the allowlist is reported by name", () => {
  const problems = checkResponses(doc, ["GET /empty-schema", "POST /no-content"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /GET \/error-only/);
});

test("an allowlist entry that is now typed is reported", () => {
  const problems = checkResponses(doc, ["GET /empty-schema", "POST /no-content", "GET /error-only", "GET /typed", "DELETE /gone"]);
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /GET \/typed/);
  assert.match(problems.join("\n"), /DELETE \/gone/);
});

test("an allowlist entry for a removed operation is reported", () => {
  const problems = checkResponses(doc, ["GET /empty-schema", "POST /no-content", "GET /error-only", "GET /missing"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /GET \/missing/);
});

test("the CLI exits 1 naming the operation, and 0 when they agree", () => {
  const dir = mkdtempSync(join(tmpdir(), "openapi-check-"));
  const spec = join(dir, "openapi.json");
  const list = join(dir, "allowlist.json");
  writeFileSync(spec, JSON.stringify(doc));
  const script = join(dirname(fileURLToPath(import.meta.url)), "check-openapi-responses.mjs");
  writeFileSync(list, JSON.stringify(["GET /empty-schema", "POST /no-content"]));
  const bad = spawnSync(process.execPath, [script, "--openapi", spec, "--allowlist", list], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /GET \/error-only/);
  writeFileSync(list, JSON.stringify(["GET /empty-schema", "POST /no-content", "GET /error-only"]));
  const good = spawnSync(process.execPath, [script, "--openapi", spec, "--allowlist", list], { encoding: "utf8" });
  assert.equal(good.status, 0);
});
