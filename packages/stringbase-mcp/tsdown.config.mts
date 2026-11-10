import { defineConfig } from 'tsdown';
export default defineConfig({ entry: { index: 'source/index.ts', cli: 'source/cli.ts' }, outDir: 'distribution', format: ['esm'], platform: 'node', target: 'node22', fixedExtension: true, dts: true, sourcemap: true, clean: true });
