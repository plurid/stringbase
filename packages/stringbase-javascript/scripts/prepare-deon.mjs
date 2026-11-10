import { build } from 'tsdown';
import { createRequire } from 'node:module';
import { copyFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchDeon } from './deon-compatibility.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const dependency = dirname(require.resolve('@plurid/deon/package.json'));
// The upstream Git package has no prepare hook and its files whitelist omits
// source. Build the exact public revision separately; never edit a sibling repo.
const manifest = require(resolve(root, 'package.json'));
const revision = manifest.devDependencies['@plurid/deon'].split('#')[1].split('&')[0];
const temporary = await mkdtemp(resolve(tmpdir(), 'stringbase-deon-'));
try {
    const archive = resolve(temporary, 'source.tar');
    if (process.env.STRINGBASE_DEON_SOURCE) {
        const bytes = execFileSync('git', ['-C', process.env.STRINGBASE_DEON_SOURCE, 'archive', '--format=tar', revision], { maxBuffer: 64 * 1024 * 1024 });
        await writeFile(archive, bytes);
    } else {
        const response = await fetch(`https://codeload.github.com/plurid/deon/tar.gz/${revision}`, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Deon archive: HTTP ${response.status}`);
        await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    }
    const extract = ['-xf', archive, '-C', temporary];
    if (!process.env.STRINGBASE_DEON_SOURCE) extract.push('--strip-components', '1');
    execFileSync('tar', extract);
    const source = resolve(temporary, 'packages/deon-javascript');
    await patchDeon(source);
    await build({
        config: false, cwd: source, entry: [resolve(source, 'source/pure.ts')],
        outDir: resolve(dependency, 'distribution'), format: ['esm', 'cjs'],
        tsconfig: resolve(source, 'tsconfig.json'), platform: 'node', target: 'node22',
        fixedExtension: true, clean: true,
        dts: { compilerOptions: { typeRoots: [resolve(root, 'node_modules/@types')] } },
    });
    await copyFile(resolve(dependency, 'distribution/pure.d.mts'), resolve(dependency, 'distribution/pure.d.ts'));
} finally { await rm(temporary, { recursive: true, force: true }); }
