import { readFileSync } from "node:fs";
import { join } from "node:path";

// Checks a live response against the schema committed in openapi.json, so a declared response cannot drift from what the handler returns:
// every declared key must be there with the declared type, and a key the schema does not declare is a failure too.
type Schema = Record<string, unknown> & { $ref?: string; type?: string; nullable?: boolean; enum?: unknown[]; pattern?: string; format?: string; required?: string[]; properties?: Record<string, Schema>; items?: Schema; additionalProperties?: boolean | Schema; allOf?: Schema[] };
interface Doc {
  paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema?: Schema }> }> }>>;
  components: { schemas: Record<string, Schema> };
}

let cached: Doc | undefined;
const doc = (): Doc => (cached ??= JSON.parse(readFileSync(join(__dirname, "..", "..", "openapi.json"), "utf8")) as Doc);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function resolve(schema: Schema): Schema {
  if (schema.$ref) {
    const target = doc().components.schemas[schema.$ref.replace("#/components/schemas/", "")];
    if (!target) throw new Error(`unknown schema ${schema.$ref}`);
    return resolve(target);
  }
  if (schema.allOf) return schema.allOf.map(resolve).reduce((a, b) => ({ ...a, ...b, required: [...(a.required ?? []), ...(b.required ?? [])], properties: { ...a.properties, ...b.properties } }), {} as Schema);
  return schema;
}

export function problemsOf(value: unknown, declared: Schema, at = "body"): string[] {
  const schema = resolve(declared);
  if (value === null) return schema.nullable ? [] : [`${at}: null, but the schema does not allow it`];
  const bad = (what: string) => [`${at}: expected ${what}, got ${JSON.stringify(value)?.slice(0, 80)}`];
  if (schema.enum && !schema.enum.includes(value)) return bad(`one of ${JSON.stringify(schema.enum)}`);
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") return bad("a string");
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) return bad(`a string matching ${schema.pattern}`);
      if (schema.format === "date-time" && !ISO.test(value)) return bad("an ISO date-time");
      return [];
    case "integer":
      return Number.isInteger(value) ? [] : bad("an integer");
    case "number":
      return typeof value === "number" ? [] : bad("a number");
    case "boolean":
      return typeof value === "boolean" ? [] : bad("a boolean");
    case "array":
      return Array.isArray(value) ? value.flatMap((item, i) => (schema.items ? problemsOf(item, schema.items, `${at}[${i}]`) : [])) : bad("an array");
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) return bad("an object");
      const record = value as Record<string, unknown>;
      const out: string[] = [];
      for (const key of schema.required ?? []) if (!(key in record)) out.push(`${at}.${key}: missing`);
      const declaredProps = schema.properties ?? {};
      for (const [key, v] of Object.entries(record)) {
        if (declaredProps[key]) out.push(...problemsOf(v, declaredProps[key], `${at}.${key}`));
        else if (typeof schema.additionalProperties === "object") out.push(...problemsOf(v, schema.additionalProperties, `${at}.${key}`));
        else if (!schema.additionalProperties && schema.properties) out.push(`${at}.${key}: not declared in the schema`);
      }
      return out;
    }
    default:
      return [];
  }
}

/** `key` is "METHOD /v1/path/{param}" as in openapi.json; the response's own status picks the declared response. */
export function declaredProblems(res: { status: number; body: unknown }, key: string): string[] {
  const [method, path] = key.split(" ");
  const response = doc().paths[path]?.[method.toLowerCase()]?.responses[String(res.status)];
  const schema = response?.content?.["application/json"]?.schema;
  if (!schema) return [`${key} declares no JSON schema for status ${res.status}`];
  return problemsOf(res.body, schema);
}

export function expectDeclared(res: { status: number; body: unknown }, key: string): void {
  expect(declaredProblems(res, key)).toEqual([]);
}

/** Checks a successful (2xx) response against its declared schema and returns it, so a helper can wrap every call it makes. */
export function checkDeclared<T extends { status: number; body: unknown }>(res: T, key: string): T {
  if (res.status < 300) expectDeclared(res, key);
  return res;
}
