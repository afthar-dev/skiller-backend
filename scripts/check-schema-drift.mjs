// CI guard: prisma/migrations must produce exactly prisma/schema.prisma.
// Usage: DATABASE_URL=<empty scratch db> node scripts/check-schema-drift.mjs
//
// `prisma migrate diff --exit-code` alone cannot be used: Prisma always reports indexes declared with raw operator
// classes (`ops: raw("text_pattern_ops")`) as changed, even right after they were created from the migration.
// Known false positives are filtered at clause level by check-schema-drift-lib.mjs (exact text); anything else fails the build.
import { spawnSync } from "node:child_process";
import { findDrift } from "./check-schema-drift-lib.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL (shadow database) is required");
  process.exit(2);
}

const run = spawnSync(
  "pnpm",
  ["prisma", "migrate", "diff", "--from-migrations", "prisma/migrations", "--to-schema-datamodel", "prisma/schema.prisma", "--shadow-database-url", url, "--script"],
  { encoding: "utf8", shell: process.platform === "win32" },
);
if (run.status !== 0) {
  console.error(run.stdout, run.stderr);
  process.exit(run.status ?? 1);
}

const unexpected = findDrift(run.stdout);
if (unexpected.length > 0) {
  console.error(`Schema drift: prisma/schema.prisma differs from prisma/migrations. Run \`pnpm db:migrate:new <name>\`. Pending changes:${"\n"}`);
  console.error(unexpected.join("\n\n"));
  process.exit(1);
}
console.log("schema matches migrations (known hand-written index / generated-column noise ignored)");
