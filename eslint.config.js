import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", ".pgdata/", "var/", "fixtures/scorm/**", "src/web/static/**", "playwright-report/", "test-results/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-restricted-imports": ["error", {
        patterns: [{ group: ["**/db/pool", "**/db/pool.js"], message: "Use withAuthz/withSystem from db/scoped (ADR-0004). Raw pool access is restricted." }],
      }],
    },
  },
  { files: ["scripts/**/*.mjs"], languageOptions: { globals: { process: "readonly" } } },
  {
    files: ["src/db/**", "src/services.ts", "test/**", "dev/**", "e2e/**"],
    rules: { "no-restricted-imports": "off" },
  },
);
