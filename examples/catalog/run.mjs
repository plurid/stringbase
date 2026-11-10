import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Workspace } from '../../packages/stringbase-javascript/distribution/agent.mjs';
import { publishReviewedChanges } from './publish.mjs';

const load = async name => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
const data = await load('snapshot.json'); const policy = await load('policy.json'); const program = await load('program.json');
const directory = await mkdtemp(join(tmpdir(), 'stringbase-catalog-')); const started = performance.now();
const source = { revision: 'catalog-source-1', products: data.products.map((product, index) => ({ ...product, priceCents: 2500 + index, inventory: 10, active: true, internalNote: null })) };
let workspace;
try {
    workspace = await Workspace.create({ directory: join(directory, 'workspace'), data, policy, sourceRevision: source.revision, actor: 'catalog-app' });
    const run = await workspace.fork({ actor: 'catalog-agent', label: 'Improve lamp description', requestId: 'fork' });
    const agent = workspace.agent(run.id);
    const plan = await agent.plan(program, { requestId: 'plan' }); assert.equal(plan.findings.length, 0);
    const applied = await agent.apply(plan.id, { requestId: 'apply' }); assert.equal((await workspace.replay(applied.id)).matches, true);
    const proposal = await agent.submit({ requestId: 'submit' });
    const review = await workspace.review(proposal.id);
    // A real application displays this review to its user and calls approve only after their decision.
    const approval = await workspace.approve(proposal.id, { reviewer: 'example-reviewer', requestId: 'approve' });
    await workspace.promote(approval.id, { reviewer: 'example-reviewer', requestId: 'promote' });
    const exported = await workspace.exportChanges();
    const published = publishReviewedChanges(source, exported, 'catalog-source-2');
    assert.equal(published.products[0].description, program.mutation.value.description);
    for (const key of ['priceCents', 'inventory', 'active', 'internalNote']) assert.deepEqual(published.products[0][key], source.products[0][key]);
    assert.equal(source.products[0].description, 'A lamp');
    assert.throws(() => publishReviewedChanges({ ...source, revision: 'changed' }, exported, 'next'), /Source revision changed/);
    const changed = structuredClone(source); changed.products[0].description = 'Concurrent edit';
    assert.throws(() => publishReviewedChanges(changed, exported, 'next'), /Source field changed/);
    console.log(JSON.stringify({ approvedChanges: review.total, protectedFieldsPreserved: true, staleSourceRejected: true, elapsedMs: Math.round(performance.now() - started), sourceRevision: published.revision }, null, 2));
} finally { if (workspace) await workspace.close(); await rm(directory, { recursive: true, force: true }); }
