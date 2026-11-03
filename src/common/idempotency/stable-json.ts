/** JSON with object keys sorted at every level, so two bodies that differ only in key order hash the same. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value)) ?? "null";
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}
