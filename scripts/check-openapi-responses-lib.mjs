// Fails when an operation without a typed success response is missing from the allowlist, when an allowlisted
// operation is now typed (or gone), or when the allowlist is longer than its committed ceiling. The ceiling only falls:
// it must equal the list's length, so removing an entry lowers it in the same change and adding one shows up as a raise.
// An operation is typed when a 2xx response is 204, a text/event-stream with a described schema, or its application/json schema describes a shape (properties, items or a $ref):
// an empty schema or a bare { type: "object" } placeholder is untyped.
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
    if (response?.content?.["text/event-stream"]?.schema?.type) return true; // a documented event stream
    const schema = response?.content?.["application/json"]?.schema;
    return !!schema && typeof schema === "object" && ("properties" in schema || "items" in schema || "$ref" in schema);
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
export function checkResponses(document, allowlist, ceiling) {
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
  if (ceiling !== undefined) {
    if (allowlist.length > ceiling) problems.push(`the allowlist has ${allowlist.length} entries, over its ceiling of ${ceiling}: type the new operations instead of allowlisting them`);
    else if (allowlist.length < ceiling) problems.push(`the allowlist shrank to ${allowlist.length} entries: lower the ceiling from ${ceiling} to ${allowlist.length}`);
  }
  return problems;
}

export function main(argv = process.argv.slice(2)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const args = argv;
  const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const document = JSON.parse(readFileSync(option("--openapi", join(root, "openapi.json")), "utf8"));
  const allowlist = JSON.parse(readFileSync(option("--allowlist", join(root, "scripts", "openapi-untyped-allowlist.json")), "utf8"));
  const ceiling = JSON.parse(readFileSync(option("--ceiling", join(root, "scripts", "openapi-untyped-ceiling.json")), "utf8")).max;
  const problems = checkResponses(document, allowlist, ceiling);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`openapi responses ok (${allowlist.length} untyped operations allowlisted, ceiling ${ceiling})`);
}

