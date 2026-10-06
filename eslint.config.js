import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      ".verify-logs/**",
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // An un-awaited write or Logging call fails silently and the job reports
      // success. For a system whose whole job is noticing failures, that is the
      // worst possible bug class, so it is an error rather than a warning.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // Remove unused code; do not keep it alive with an underscore.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    // Configured, never forked (CLAUDE.md): src/config.ts is the only reader of the environment. The edit-time
    // hook (config-boundary-guard.sh) only sees newly written text; this sees every file, every run. Tests may
    // set the environment to exercise config.ts, so they are exempt, as they are from the hook.
    files: ["src/**/*.ts"],
    ignores: ["src/config.ts", "src/**/*.test.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "process", property: "env", message: "Read the environment only in src/config.ts: add a StarfishConfig field or a loader there." },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: ["node:process", "process"].map((name) => ({
            name,
            importNames: ["env"],
            message: "Read the environment only in src/config.ts: add a StarfishConfig field or a loader there.",
          })),
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          // `import * as p from "node:process"` and `import p from "node:process"`: either would make `p.env` a read
          // under a name the rules above do not know. Import what you need by name.
          selector: ":matches(ImportNamespaceSpecifier, ImportDefaultSpecifier)[parent.source.value=/^(node:)?process$/]",
          message: "Import what you need from node:process by name; the environment is read only in src/config.ts.",
        },
      ],
    },
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    files: ["scripts/**/*.mjs", "rules/**/*.ts", "*.js", "*.ts", "web/*.ts"],
    languageOptions: { globals: globals.node },
  }
);
