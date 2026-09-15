import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    // Global ignore — must be its own config object with no "files" key
    // for ESLint's flat config to treat it as project-wide, not scoped
    // to the object below it. (Real bug found and fixed during this
    // build: dist/ output was being linted as source, which produced 6
    // failures that had nothing to do with the actual source code.)
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": ["warn", { allow: ["error"] }],
    },
  },
  {
    // The migration CLI is a terminal tool — console output IS its
    // product, not a debugging leftover.
    files: ["packages/database/src/migrate.ts", "packages/database/src/seed.ts"],
    rules: { "no-console": "off" },
  },
];
