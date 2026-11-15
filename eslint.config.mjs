// Only rules that catch bugs: formatting is prettier's, and types are tsc's.
// The typed rules read each file's own package tsconfig (projectService).
import { defineConfig } from "eslint/config";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

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
      parserOptions: {
        projectService: {
          // Package test configs that no package tsconfig includes.
          allowDefaultProject: [
            "packages/protocol/vitest.config.ts",
            "packages/client-core/vitest.config.ts",
            "packages/server/vitest.config.ts",
            "apps/desktop/vitest.config.ts",
            "ee/vitest.config.ts",
            "ee/cloud/vitest.config.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
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
    // The Playwright suites and measuring scripts are typed by their own
    // tsconfig, which is not named tsconfig.json, so the service cannot find it.
    files: [
      "playwright*.config.ts",
      "tests/e2e/**/*.ts",
      "tests/visual/**/*.ts",
      "scripts/**/*.mts",
    ],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: "./tsconfig.automation.json",
        tsconfigRootDir: import.meta.dirname,
      },
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
      // Messages are articles in a feed, each a Tab stop with arrow keys
      // between them (WAI-ARIA feed pattern).
      "jsx-a11y/no-noninteractive-tabindex": [
        "error",
        { tags: [], roles: ["tabpanel", "article"], allowExpressionValues: true },
      ],
      // A choice's title and hint sit in spans inside its label, for layout.
      "jsx-a11y/label-has-associated-control": ["error", { depth: 4 }],
    },
  },
);
