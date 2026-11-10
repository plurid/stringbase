import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Workspace } from '../distribution/agent.mjs';

if (process.argv[2] !== '--size') {
    const results = [1000, 10000].map(size => JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--size', String(size)], { encoding: 'utf8', maxBuffer: 1024 * 1024 })));
    console.log(JSON.stringify(results, null, 2));
} else {
    const size = Number(process.argv[3]);
    if (![1000, 10000].includes(size)) throw new Error('Unsupported benchmark size.');
    const temporary = await mkdtemp(join(tmpdir(), 'stringbase-workspace-benchmark-')); const directory = join(temporary, 'workspace');
    const data = { products: Array.from({ length: size }, (_, index) => ({ id: String(index), description: 'Original product description ' + index, category: 'home', tags: ['catalog'] })) };
    const policy = { version: 'benchmark-1', read: ['/products/*'], write: ['/products/*/description'], schema: { products: { description: { kind: 'string' }, category: { kind: 'string' }, tags: { kind: 'strings' } } } };
    const measure = async callback => { const start = performance.now(); const result = await callback(); return { result, ms: Math.round((performance.now() - start) * 100) / 100 }; };
    const bytes = async () => {
        const names = await readdir(join(directory, 'objects')); let total = (await stat(join(directory, 'manifest.deon'))).size;
        for (const name of names) total += (await stat(join(directory, 'objects', name))).size;
        return { bytes: total, snapshots: names.length };
    };
    let workspace;
    try {
        const created = await measure(() => Workspace.create({ directory, data, policy, sourceRevision: 'source', actor: 'benchmark' })); workspace = created.result;
        const initial = await bytes();
        const forks = await measure(async () => { const runs = []; for (let i = 0; i < 5; i++) runs.push(await workspace.fork({ actor: 'agent-' + i, requestId: 'fork-' + i })); return runs; });
        const forked = await bytes(); const agent = workspace.agent(forks.result[0].id);
        const query = { version: 1, collection: 'products', query: { version: 1, steps: [{ op: 'where', predicate: { op: 'in', value: { op: 'field', path: ['id'] }, values: Array.from({ length: 10 }, (_, i) => String(i)) } }] } };
        const queried = await measure(() => agent.query(query));
        const planned = await measure(() => agent.plan({ ...query, mutation: { op: 'merge', value: { description: 'Updated product copy' } } }, { requestId: 'plan' }));
        const applied = await measure(() => agent.apply(planned.result.id, { requestId: 'apply' }));
        const proposal = await agent.submit({ requestId: 'submit' });
        const review = await measure(() => workspace.review(proposal.id));
        const approval = await workspace.approve(proposal.id, { reviewer: 'benchmark-human', requestId: 'approve' });
        const promoted = await measure(() => workspace.promote(approval.id, { reviewer: 'benchmark-human', requestId: 'promote' }));
        const final = await bytes(); await workspace.close();
        const reopened = await measure(() => Workspace.open({ directory })); workspace = reopened.result;
        console.log(JSON.stringify({ documents: size, node: process.version, platform: process.platform, architecture: process.arch,
            createMs: created.ms, fiveForksMs: forks.ms, queryMs: queried.ms, planTenMs: planned.ms, applyTenMs: applied.ms, reviewMs: review.ms, promoteMs: promoted.ms, reopenMs: reopened.ms,
            initialBytes: initial.bytes, afterForkBytes: forked.bytes, finalBytes: final.bytes, snapshotsBefore: initial.snapshots, snapshotsAfterForks: forked.snapshots, snapshotsFinal: final.snapshots,
            peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024 * 10) / 10 }));
    } finally { if (workspace) await workspace.close(); await rm(temporary, { recursive: true, force: true }); }
}
