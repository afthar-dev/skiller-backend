import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";

/** Names of the migration directories bundled with this build (the image carries prisma/migrations next to dist/). */
export function bundledMigrations(dir = join(process.cwd(), "prisma", "migrations")): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** Bundled migrations that the database has not recorded as finished. */
export async function pendingMigrations(prisma: Pick<PrismaClient, "$queryRaw">, bundled: string[]): Promise<string[]> {
  if (bundled.length === 0) return [];
  const rows = await prisma.$queryRaw<{ migration_name: string }[]>`SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`;
  const done = new Set(rows.map((r) => r.migration_name));
  return bundled.filter((m) => !done.has(m));
}

export interface GateOptions {
  bundled?: string[];
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * The worker and the API deploy independently, and only the API runs `prisma migrate deploy` (pre-deploy). A worker that starts first would run new code against the
 * old schema, and scheduled jobs (attempts 1) would lose those runs. So the worker waits here until every migration in its own image is recorded as applied, and gives up
 * (the process exits and Render restarts it) after `timeoutMs`.
 */
export async function waitForMigrations(prisma: Pick<PrismaClient, "$queryRaw">, opts: GateOptions = {}): Promise<void> {
  const bundled = opts.bundled ?? bundledMigrations();
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = Date.now();
  for (;;) {
    const pending = await pendingMigrations(prisma, bundled);
    if (pending.length === 0) return;
    if (Date.now() - started >= timeoutMs) throw new Error(`database is missing migrations: ${pending.join(", ")}`);
    opts.log?.(`waiting for migrations: ${pending.length} pending (${pending[0]}...)`);
    await sleep(intervalMs);
  }
}
