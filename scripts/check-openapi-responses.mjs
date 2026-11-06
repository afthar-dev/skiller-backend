// Fails when an operation without a typed success response is missing from the allowlist, or when an allowlisted
// operation is now typed (or gone). The allowlist can therefore only shrink.
// An operation is typed when a 2xx response is 204 or has a non-empty application/json schema.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch"];

export function operationKey(method, path) {
  return `${method.toUpperCase()} ${path}`;
}

function isTyped(operation) {
  return Object.entries(operation.responses ?? {}).some(([status, response]) => {
    if (!/^2\d\d$/.test(status)) return false;
    if (status === "204") return true;
    const schema = response?.content?.["application/json"]?.schema;
    return !!schema && typeof schema === "object" && Object.keys(schema).length > 0;
  });
}

/** Map of "METHOD /path" to whether the operation is typed. */
export function classifyOperations(document) {
  const result = new Map();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      if (item?.[method]) result.set(operationKey(method, path), isTyped(item[method]));
    }
  }
  return result;
}

/** Returns the problems found; an empty list means the contract and the allowlist agree. */
export function checkResponses(document, allowlist) {
  const operations = classifyOperations(document);
  const allowed = new Set(allowlist);
  const problems = [];
  for (const [key, typed] of operations) {
    if (!typed && !allowed.has(key)) problems.push(`untyped operation not in the allowlist: ${key}`);
  }
  for (const key of allowed) {
    if (!operations.has(key)) problems.push(`allowlist entry no longer exists in the contract (remove it): ${key}`);
    else if (operations.get(key)) problems.push(`allowlist entry is now typed (remove it; the list may only shrink): ${key}`);
  }
  return problems;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const document = JSON.parse(readFileSync(option("--openapi", join(root, "openapi.json")), "utf8"));
  const allowlist = JSON.parse(readFileSync(option("--allowlist", join(root, "scripts", "openapi-untyped-allowlist.json")), "utf8"));
  const problems = checkResponses(document, allowlist);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`openapi responses ok (${allowlist.length} untyped operations allowlisted)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
