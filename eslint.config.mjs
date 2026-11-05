import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Module boundaries (enforced with ESLint core's no-restricted-imports, which needs no import resolver):
//  - src/modules/<x> may import src/common/**, its own files, and another module <y> only through "../<y>" (its index.ts).
//  - src/common/** must not import from src/modules/**.
// eslint-plugin-boundaries was evaluated and dropped: v7 needs a TS import resolver plus a policy DSL for what is a one-line pattern here.
const MODULES = ["admin", "audit", "billing", "courses", "identity", "mail", "media", "moderation", "notifications", "organizations", "rbac", "users", "wallet"];

const boundaryBlocks = MODULES.map((self) => ({
  files: [`src/modules/${self}/**/*.{ts,tsx}`],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: MODULES.filter((other) => other !== self).map((other) => `**/${other}/**`),
            message: `Module boundary: import another module only through its index ("../<module>"), never a deep path.`,
          },
          { group: ["**/modules/**"], message: "Module boundary: import another module through its index (../<module>), not via src/modules paths." },
        ],
      },
    ],
  },
}));

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "edge/**/.wrangler/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  ...boundaryBlocks,
  {
    // Permission declarations: each module defines its keys with definePermissions (rbac/permission.registry), and rbac/permissions.ts imports those files to register them.
    files: ["src/modules/*/permissions.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["src/common/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/modules/**"], message: "src/common must not depend on feature modules." }] }],
    },
  },
);
