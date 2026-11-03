import { randomInt } from "node:crypto";

export const HANDLE_PATTERN = /^[a-z0-9_]{3,30}$/;
export const RESERVED_HANDLES: ReadonlySet<string> = new Set(["admin", "api", "skiller", "support", "settings", "me", "v1"]);

/** Handles are stored lower-case; a leading "@" is allowed on input. */
export function normalizeHandle(input: string): string {
  return input.trim().replace(/^@/, "").toLowerCase();
}

export const isValidHandle = (normalized: string) => HANDLE_PATTERN.test(normalized);
export const isReservedHandle = (normalized: string) => RESERVED_HANDLES.has(normalized);

/** Email local part (sanitised to [a-z0-9_]) plus 4 random digits; always a valid, non-reserved handle. */
export function generateHandle(email: string): string {
  const local = email.split("@")[0] ?? "";
  let base = local.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
  if (base.length < 3) base = `user${base}`;
  return `${base}${String(randomInt(0, 10_000)).padStart(4, "0")}`;
}

export function defaultDisplayName(email: string): string {
  const local = (email.split("@")[0] ?? "").trim();
  return (local || "Skiller user").slice(0, 80);
}
