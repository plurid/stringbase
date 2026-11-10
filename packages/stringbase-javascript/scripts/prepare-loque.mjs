import { build } from 'tsdown';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const dependency = dirname(require.resolve('@plurid/loque/package.json'));
// Build the exact pinned public source; never edit a sibling repository.
const manifest = require(resolve(root, 'package.json'));
const revision = manifest.devDependencies['@plurid/loque'].split('#')[1].split('&')[0];
const temporary = await mkdtemp(resolve(tmpdir(), 'stringbase-loque-'));
try {
    const archive = resolve(temporary, 'source.tar');
    if (process.env.STRINGBASE_LOQUE_SOURCE) {
        const bytes = execFileSync('git', ['-C', process.env.STRINGBASE_LOQUE_SOURCE, 'archive', '--format=tar', revision], { maxBuffer: 64 * 1024 * 1024 });
        await writeFile(archive, bytes);
    } else {
        const response = await fetch(`https://codeload.github.com/plurid/loque/tar.gz/${revision}`, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Loque archive: HTTP ${response.status}`);
        await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    }
    const extract = ['-xf', archive, '-C', temporary];
    if (!process.env.STRINGBASE_LOQUE_SOURCE) extract.push('--strip-components', '1');
    execFileSync('tar', extract);
    const source = resolve(temporary, 'packages/loque-javascript');
    await build({
        config: false, cwd: source, entry: [resolve(source, 'source/index.ts')],
        outDir: resolve(dependency, 'distribution'), format: ['esm', 'cjs'],
        tsconfig: resolve(source, 'tsconfig.json'), platform: 'node', target: 'node22',
        fixedExtension: true, clean: true,
        cjsDefault: false,
        dts: { compilerOptions: { typeRoots: [resolve(root, 'node_modules/@types')] } },
    });
} finally { await rm(temporary, { recursive: true, force: true }); }
