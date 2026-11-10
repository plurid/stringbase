import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'stringbase-package-'));
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'pipe', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
try {
    const tarball = join(temporary, 'stringbase.tgz');
    run('pnpm', ['pack', '--out', tarball]);
    const entries = run('tar', ['-tzf', tarball]).trim().split('\n');
    assert.ok(entries.every(name => /^package\/(distribution\/|package\.json$|README\.md$|LICENSE(?:\.deon)?$)/.test(name)), 'Unexpected published files');
    assert.ok(entries.every(name => !name.includes('.test.') && !name.includes('__tests__')), 'Tests leaked into the tarball');
    run('pnpm', ['exec', 'publint', tarball, '--strict']);

    const consumer = join(temporary, 'consumer');
    await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'stringbase-consumer', private: true, type: 'module', dependencies: { '@plurid/stringbase': `file:${tarball}` } }));
    await writeFile(join(consumer, 'pnpm-workspace.yaml'), 'packages: []\n');
    run('pnpm', ['install', '--prod', '--no-lockfile', '--ignore-workspace'], consumer);
    await writeFile(join(consumer, 'runtime.mjs'), `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Stringbase, { Stringbase as Named, query, field, literal, eq } from '@plurid/stringbase';
const require = createRequire(import.meta.url);
const cjs = require('@plurid/stringbase');
assert.equal(Stringbase, Named);
assert.equal(cjs.default, cjs.Stringbase);
const db = await Stringbase.create({ filepath: './consumer.deon' });
await db.createCollection('records');
await db.collection('records').insertOne({ id: '01', value: 'kept' });
await assert.rejects(cjs.Stringbase.open({ filepath: './consumer.deon' }), { code: 'STRINGBASE_LOCKED' });
await db.close();
const reopened = await cjs.Stringbase.open({ filepath: './consumer.deon' });
assert.equal((await reopened.collection('records').get('01')).value, 'kept');
assert.equal((await reopened.collection('records').find(query().where(eq(field('id'), literal('01'))))).length, 1);
await reopened.close();
assert.throws(() => require.resolve('@plurid/deon/pure'));
assert.throws(() => require.resolve('@plurid/loque'));
`);
    run(process.execPath, [join(consumer, 'runtime.mjs')], consumer);
    const binary = join(consumer, 'node_modules/.bin/stringbase');
    assert.equal(run(binary, ['--version'], consumer).trim(), manifest.version);
    assert.ok((await stat(join(consumer, 'node_modules/@plurid/stringbase/distribution/cli.mjs'))).mode & 0o111);
    for (const [extension, code] of [
        ['mts', `import Stringbase, { query, field, literal, eq, type Document } from '@plurid/stringbase'; export const example = async () => { const db = await Stringbase.open({filepath:'example.deon'}); const results: readonly Document[] = await db.collection('records').find(query().where(eq(field('id'),literal('1')))); await db.close(); return results; };`],
        ['cts', `import sb = require('@plurid/stringbase'); export const example = async () => { const db: sb.Stringbase = await sb.Stringbase.open({filepath:'example.deon'}); const results: readonly sb.Document[] = await db.collection('records').find(sb.query()); await db.close(); return results; };`],
    ]) await writeFile(join(consumer, `types.${extension}`), code);
    for (const [module, moduleResolution, files] of [['NodeNext', 'NodeNext', ['types.mts', 'types.cts']], ['ESNext', 'Bundler', ['types.mts']]]) {
        const config = join(consumer, `tsconfig.${moduleResolution}.json`);
        await writeFile(config, JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2024'], module, moduleResolution, strict: true, noEmit: true, types: ['node'], typeRoots: [join(root, 'node_modules/@types')] }, files }));
        run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', config], consumer);
    }
    console.log('Packed consumer passed: clean dependency-free production install, ESM/CJS, writer ownership, CLI, NodeNext/Bundler types, publint.');
} catch (error) {
    if (error && typeof error === 'object' && 'stderr' in error) console.error(String(error.stderr));
    throw error;
} finally { await rm(temporary, { recursive: true, force: true }); }
