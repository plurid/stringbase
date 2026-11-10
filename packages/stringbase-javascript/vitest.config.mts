import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
    include: ['tests/**/*.test.ts'], testTimeout: 20_000,
    coverage: { provider: 'v8', include: ['source/**/*.ts'],
        // Executables are exercised as child processes; V8 coverage is collected in-process.
        exclude: ['source/cli.ts', 'source/workspace-cli.ts', 'source/index.ts', 'source/types.ts'],
        reporter: ['text', 'json-summary'],
        thresholds: { statements: 90, branches: 85, functions: 95, lines: 90 } },
} });
