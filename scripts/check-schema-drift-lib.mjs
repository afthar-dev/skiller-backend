// Pure filter for `prisma migrate diff --script` output. Prisma re-reports a few hand-written database objects on every
// run; those exact statements/clauses are ignored. Everything else is drift. Matching is on exact text, at clause level,
// because Prisma folds every change to one table into a single ALTER TABLE statement.

// Hand-written objects Prisma cannot express (see README, Courses: hand-written database objects).
export const KNOWN_NOISE_STATEMENTS = [
  'DROP INDEX "courses_search_vector_idx";',
  'DROP INDEX "courses_title_trgm_idx";',
  'DROP INDEX "reels_search_vector_idx";',
  'DROP INDEX "reels_caption_trgm_idx";',
  'DROP INDEX "profiles_handle_pattern_idx";',
  'DROP INDEX "users_email_pattern_idx";',
  'CREATE INDEX "profiles_handle_pattern_idx" ON "profiles"("handle" text_pattern_ops);',
  'CREATE INDEX "users_email_pattern_idx" ON "users"("email" text_pattern_ops);',
];

// The generated column "ratingShown" is reported as a default/type change.
export const KNOWN_NOISE_CLAUSES = {
  courses: ['ALTER COLUMN "ratingShown" DROP DEFAULT', 'ALTER COLUMN "ratingShown" SET DATA TYPE numeric(3,2)'],
};

const norm = (s) => s.replace(/\s+/g, " ").trim();

function splitStatements(sql) {
  const out = [];
  let cur = [];
  for (const line of sql.split(/\r?\n/)) {
    if (line.startsWith("warn ") || line.startsWith("For more information") || line.trim().startsWith("--")) continue;
    cur.push(line);
    if (line.trimEnd().endsWith(";")) {
      out.push(cur.join("\n").trim());
      cur = [];
    }
  }
  const rest = cur.join("\n").trim();
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

// Comma split at depth 0 (numeric(3,2), defaults with parentheses, quoted strings).
function splitClauses(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map(norm).filter(Boolean);
}

/** Returns the statements (or remaining clauses, re-assembled) that are real drift. */
export function findDrift(sql) {
  const drift = [];
  for (const statement of splitStatements(sql)) {
    if (KNOWN_NOISE_STATEMENTS.includes(norm(statement))) continue;
    const alter = /^ALTER TABLE ("[^"]+")\s+([\s\S]*);$/.exec(statement);
    if (alter) {
      const table = alter[1].slice(1, -1);
      const known = KNOWN_NOISE_CLAUSES[table] ?? [];
      const left = splitClauses(alter[2]).filter((clause) => !known.includes(clause));
      if (left.length > 0) drift.push(`ALTER TABLE ${alter[1]} ${left.join(",\n")};`);
      continue;
    }
    drift.push(statement);
  }
  return drift;
}
