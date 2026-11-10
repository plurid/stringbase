import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
export default defineConfig(
    globalIgnores(['distribution/**', 'coverage/**', 'node_modules/**']),
    js.configs.recommended,
    { files: ['**/*.{ts,mts,cts}'], extends: [tseslint.configs.recommended] },
    { languageOptions: { globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly', setTimeout: 'readonly', fetch: 'readonly', AbortSignal: 'readonly' } } },
);
