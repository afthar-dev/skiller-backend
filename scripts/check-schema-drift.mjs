// CI guard: prisma/migrations must produce exactly prisma/schema.prisma.
// Usage: DATABASE_URL=<empty scratch db> node scripts/check-schema-drift.mjs
//
// `prisma migrate diff --exit-code` alone cannot be used: Prisma always reports indexes declared with raw operator
// classes (`ops: raw("text_pattern_ops")`) as changed, even right after they were created from the migration.
// Those known false positives (a DROP INDEX / CREATE INDEX pair per index) are ignored; anything else fails the build.
import { spawnSync } from "node:child_process";

const KNOWN_RAW_OPS_INDEXES = ["profiles_handle_pattern_idx", "users_email_pattern_idx"];
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

const statements = run.stdout
  .split(/\r?\n/)
  .filter((line) => !line.startsWith("warn ") && !line.startsWith("For more information"))
  .join("\n")
  .split(/\n\s*\n/)
  .map((block) => block.trim())
  .filter((block) => block && block !== "-- This is an empty migration.");

const unexpected = statements.filter((block) => !KNOWN_RAW_OPS_INDEXES.some((name) => block.includes(`"${name}"`)));
if (unexpected.length > 0) {
  console.error("Schema drift: prisma/schema.prisma differs from prisma/migrations. Run `pnpm db:migrate:new <name>`. Pending changes:\n");
  console.error(unexpected.join("\n\n"));
  process.exit(1);
}
console.log(`schema matches migrations (${statements.length} known raw-ops index false positive(s) ignored)`);
