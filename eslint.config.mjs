// Only rules that catch bugs: formatting is prettier's, and types are tsc's.
// The typed rules read each file's own package tsconfig (projectService).
import { defineConfig } from "eslint/config";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Turned on one package at a time (G11). Each package's pull request removes
// its line here and fixes what the rules find.
const notYetLinted = [
  "packages/ui/**",
  "ee/**",
  "apps/**",
  "tests/**",
  "scripts/**",
  ".github/**",
  // Build and test tool configs, with apps, tests and scripts.
  "**/*.config.{ts,mts,mjs,cjs,js}",
];

export default defineConfig(
  {
    ignores: [
      // What .prettierignore lists: generated files and build output.
      "pnpm-lock.yaml",
      "docs/**",
      "apps/site/docs/**",
      "packages/ui/src/lib/emojiData.json",
      "packages/ui/src/emoji.css",
      "packages/server/src/import/slackEmoji.json",
      "packages/ui/src/components/brandMark.json",
      "packages/server/openapi.json",
      "**/dist/**",
      "**/out/**",
      "**/release/**",
      "**/test-results/**",
      "**/.turbo/**",
      ".claude/worktrees/**",
      ...notYetLinted,
    ],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
    // Loaded everywhere so a disable comment naming one of their rules is
    // understood in any file.
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // A default branch is a decision about the cases it takes, so only a
      // switch with neither a default nor every case is reported.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  },
  {
    // Where React is. Elsewhere a function named `use` is not a hook. Hooks
    // live in .ts files too (useSomething.ts).
    files: ["packages/ui/**/*.{ts,tsx}", "apps/web/**/*.{ts,tsx}", "apps/desktop/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: ["**/*.tsx"],
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },
);
