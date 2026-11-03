const BACKSLASH = String.fromCharCode(92);

/** Escapes LIKE metacharacters (backslash, percent, underscore) so user input matches literally; Postgres' default LIKE escape character is the backslash. */
export const escapeLike = (value: string): string => {
  let out = "";
  for (const ch of value) out += ch === BACKSLASH || ch === "%" || ch === "_" ? BACKSLASH + ch : ch;
  return out;
};
