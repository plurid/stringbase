import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import Stringbase, { query, field, literal, eq } from '../distribution/index.mjs';

if (!process.argv[2]) {
    for (const size of [1000, 10000]) process.stdout.write(execFileSync(process.execPath, [fileURLToPath(import.meta.url), String(size)], { encoding: 'utf8' }));
} else {
    const size = Number(process.argv[2]);
    const directory = await mkdtemp(join(tmpdir(), 'stringbase-benchmark-'));
    const filepath = join(directory, 'data.deon');
    let db;
    const timed = async run => { const start = performance.now(); await run(); return Number((performance.now() - start).toFixed(2)); };
    try {
        db = await Stringbase.create({ filepath });
        await db.createCollection('records');
        await db.collection('records').insertMany(Array.from({ length: size }, (_, i) => ({ id: String(i), name: `Record ${i}`, group: String(i % 10), rank: String(i) })));
        await db.close();
        const openMs = await timed(async () => { db = await Stringbase.open({ filepath }); });
        const scanMs = await timed(() => db.collection('records').find(query().where(eq(field('group'), literal('3')))));
        const sortMs = await timed(() => db.collection('records').find(query().sort(field('rank'), 'desc').limit(20), { view: 'typed' }));
        const commitMs = await timed(() => db.collection('records').updateOne('0', { note: 'single' }));
        const batch10Ms = await timed(() => db.batch(tx => { for (let i = 0; i < 10; i++) tx.collection('records').updateOne(String(i), { note: 'batch' }); }));
        console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, documents: size, bytes: (await stat(filepath)).size, openMs, scanMs, sortMs, commitMs, batch10Ms, peakRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(1)) }));
    } finally { if (db) await db.close(); await rm(directory, { recursive: true, force: true }); }
}
