import { defineConfig } from 'tsdown';
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
export default defineConfig({
    entry: { index: 'source/index.ts', cli: 'source/cli.ts', agent: 'source/agent/index.ts' }, outDir: 'distribution',
    format: ['esm', 'cjs'], platform: 'node', target: 'node22',
    fixedExtension: true, dts: true, sourcemap: true, clean: true, cjsDefault: false,
    deps: { alwaysBundle: ['@plurid/deon', '@plurid/deon/pure', '@plurid/loque'], onlyBundle: false },
    define: { __STRINGBASE_VERSION__: JSON.stringify(version) },
});
