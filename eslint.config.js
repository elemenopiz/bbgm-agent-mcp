// @ts-check
//
// Flat config (ESLint 9+). Requires devDependencies that are NOT yet in
// package.json as of this writing -- see the lint-related entries reported
// alongside this file's introduction. Run `pnpm install` after they're
// added before running `pnpm lint`.
//
// Design notes:
// - Type-checked @typescript-eslint rule sets are used (recommendedTypeChecked
//   + stylisticTypeChecked) since this project's tsconfig.json is already
//   strict; linting should catch the same class of bug typechecking does,
//   plus the promise/import-hygiene rules typechecking alone doesn't.
// - `no-explicit-any` is an error. The escape hatch is an explicit, narrow
//   `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comment
//   at the one line that needs it -- never a blanket rule downgrade.
// - `consistent-type-imports` is enforced to match tsconfig's
//   `verbatimModuleSyntax: true`, which already requires type-only imports
//   to be written as such at the language level.
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      ".cache/**",
      ".data/**",
      "node_modules/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript's own compiler already catches undefined identifiers, and
      // does it more accurately (ambient/global types, etc.) than ESLint's
      // no-undef can for TS files.
      "no-undef": "off",

      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // This codebase consistently uses `type` for object shapes (including ones that are
      // sometimes unions, sometimes plain shapes) -- enforce that convention rather than
      // `interface`, instead of leaving the stylistic-type-checked default in place.
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      // SimulationEngine is an async interface by contract (some implementations are IPC-backed);
      // a fake/in-memory implementation legitimately has methods that never need to await anything.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },
  {
    // eslint.config.js itself is a plain Node ESM script, not part of
    // tsconfig.json's `include`, so it can't be type-checked against the
    // project -- lint it with type-aware rules disabled instead of adding it
    // to tsconfig just to satisfy the linter.
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // engine-bridge/entry.ts imports the pinned zengm checkout via ambient
    // `../src/*` module shims (engine-bridge/zengm-modules.d.ts) since this
    // repo has no compile-time dependency on that separately-supplied
    // checkout -- see that file's doc comment. Those imports are
    // deliberately `any`-typed as a documented, narrowly-scoped compatibility
    // boundary (project rule 5), so the cascade of `no-unsafe-*` findings
    // here is expected noise from an accepted tradeoff, not a real bug.
    files: ["engine-bridge/entry.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Must stay last: turns off stylistic rules that would otherwise conflict
  // with Prettier's formatting decisions.
  eslintConfigPrettier,
);
