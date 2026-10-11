import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "node_modules/**",
    ".git/**",
    "api/**",
    "database/**",
    "vendor/**",
    "backups/**",
    "uploads/**",
    "test-data/**",
    "HTML/**",
    "public/**",
    "*.php",
    "*.sql",
    "*.log",
    "*.tmp",
    "tsconfig.tsbuildinfo",
  ]),
]);

export default eslintConfig;
