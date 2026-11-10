import { describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Workspace, validatePolicy, validateProgram } from '../source/agent';
import { data, policy, program, queryProgram, request, reviewer, workspaceFixture } from './agent-helpers';

describe('agent workspaces', () => {
    const f = workspaceFixture();
    it('runs the complete fork, plan, review, promote, export, replay and revert workflow', async () => {
        const workspace = await f.create(); const initial = await workspace.describe();
        const run = await workspace.fork({ actor: 'agent:catalog', ...request() }); const agent = workspace.agent(run.id);
        const sibling = await workspace.fork({ actor: 'agent:sibling', ...request() });
        expect((await agent.query(queryProgram)).documents).toEqual(data.products);
        const plan = await agent.plan(program(), request());
        expect(plan.findings).toEqual([]); expect(plan.changes).toHaveLength(1);
        const applied = await agent.apply(plan.id, request());
        expect((await workspace.describe()).revision).toBe(initial.revision);
        expect((await workspace.agent(sibling.id).query(queryProgram)).documents[0]?.description).toBe('Old description');
        expect((await agent.query(queryProgram)).documents[0]?.description).toBe('Improved description');
        expect(await workspace.replay(applied.id)).toMatchObject({ matches: true });
        const proposal = await agent.submit(request());
        await expect(agent.apply(plan.id, request())).rejects.toMatchObject({ code: 'STRINGBASE_INVALID_STATE' });
        const review = await workspace.review(proposal.id);
        expect(review).toMatchObject({ stale: false, total: 1, findings: [] });
        const approval = await workspace.approve(proposal.id, reviewer());
        const promoted = await workspace.promote(approval.id, reviewer());
        const exported = await workspace.exportChanges();
        expect(exported).toMatchObject({ revision: promoted.id, sourceRevision: 'source-1', changes: [{ collection: 'products', id: '01', field: 'description', before: 'Old description', after: 'Improved description' }] });
        expect((await workspace.history()).items.map(item => item.kind)).toEqual(['promote', 'import']);
        const reverted = await workspace.revert(promoted.id, reviewer());
        expect((await workspace.exportChanges(reverted.id)).changes[0]).toMatchObject({ before: 'Improved description', after: 'Old description' });
        await workspace.close(); const reopened = await f.open();
        expect((await reopened.describe()).revision).toBe(reverted.id);
        const fresh = await reopened.fork({ actor: 'new', ...request() });
        expect((await reopened.agent(fresh.id).query(queryProgram)).documents).toEqual(data.products);
    });

    it('shares snapshots when forking, records immutable output and deduplicates requests across reopen', async () => {
        const workspace = await f.create(); const req = { actor: 'agent', ...request() };
        const run = await workspace.fork(req); expect(await workspace.fork(req)).toEqual(run);
        await expect(workspace.fork({ ...req, label: 'changed' })).rejects.toMatchObject({ code: 'STRINGBASE_CONFLICT' });
        expect(await readdir(join(f.filepath, 'objects'))).toHaveLength(1);
        const agent = workspace.agent(run.id); const plan = await agent.plan(program(), request()); const apply = request();
        const revision = await agent.apply(plan.id, apply);
        expect(await agent.apply(plan.id, apply)).toEqual(revision);
        expect(Object.isFrozen(revision.changes)).toBe(true);
        await workspace.close(); const reopened = await f.open();
        expect(await reopened.agent(run.id).apply(plan.id, apply)).toEqual(revision);
        expect((await reopened.receipt(apply.requestId)).result).toEqual(revision);
    });

    it('handles special request IDs and data keys without prototype mutation', async () => {
        const workspace = await f.create(); const options = { actor: 'agent', requestId: '__proto__' };
        const run = await workspace.fork(options); expect(await workspace.fork(options)).toEqual(run);
        expect((await workspace.receipt('__proto__')).result).toEqual(run);
        await workspace.close(); const reopened = await f.open();
        expect(await reopened.fork(options)).toEqual(run);
        expect(Object.prototype).not.toHaveProperty('requestId');
    });

    it('rejects forbidden changes and invalid schema values without applying them', async () => {
        const workspace = await f.create(); const run = await workspace.fork({ actor: 'agent', ...request() }); const agent = workspace.agent(run.id);
        await expect(agent.plan(program({ sku: 'modified' }), request())).rejects.toMatchObject({ code: 'STRINGBASE_CAPABILITY_DENIED' });
        await expect(agent.plan(program({ id: 'changed' }), request())).rejects.toMatchObject({ code: 'STRINGBASE_INVALID_DATA' });
        const invalid = await agent.plan(program({ category: 'unknown' }), request());
        expect(invalid.findings).toHaveLength(1);
        await expect(agent.apply(invalid.id, request())).rejects.toMatchObject({ code: 'STRINGBASE_VALIDATION_FAILED' });
        expect((await agent.describe()).revision).toBe(run.base);
        expect(await agent.diff()).toMatchObject({ total: 0 });
    });

    it('checks read access before selection and supports explicit field projections', async () => {
        const workspace = await f.create({ policy: { ...policy, read: ['/products/*/id', '/products/*/description'] } });
        const run = await workspace.fork({ actor: 'agent', ...request() }); const agent = workspace.agent(run.id);
        await expect(agent.query(queryProgram)).rejects.toMatchObject({ code: 'STRINGBASE_CAPABILITY_DENIED' });
        expect((await agent.query({ ...queryProgram, fields: ['description'] })).documents[0]).toEqual({ id: '01', description: 'Old description' });
        const probing = { ...queryProgram, fields: ['description'], query: { version: 1 as const, steps: [{ op: 'where' as const, predicate: { op: 'eq' as const, left: { op: 'field' as const, path: ['sku'] }, right: { op: 'literal' as const, value: 'nonexistent' } } }] } };
        await expect(agent.query(probing)).rejects.toMatchObject({ code: 'STRINGBASE_CAPABILITY_DENIED' });
        await expect(agent.plan(program({ category: 'tools' }), request())).rejects.toMatchObject({ code: 'STRINGBASE_CAPABILITY_DENIED' });
    });

    it('rejects stale plans and cross-run plan IDs', async () => {
        const workspace = await f.create(); const run = await workspace.fork({ actor: 'a', ...request() }); const other = await workspace.fork({ actor: 'b', ...request() });
        const agent = workspace.agent(run.id); const first = await agent.plan(program(), request()); const stale = await agent.plan(program({ description: 'Another' }), request());
        await expect(workspace.agent(other.id).apply(first.id, request())).rejects.toMatchObject({ code: 'STRINGBASE_CAPABILITY_DENIED' });
        await agent.apply(first.id, request());
        await expect(agent.apply(stale.id, request())).rejects.toMatchObject({ code: 'STRINGBASE_CONFLICT' });
        await expect(agent.query(queryProgram, { expectedRevision: run.head })).rejects.toMatchObject({ code: 'STRINGBASE_CONFLICT' });
    });

    it('invalidates stale approvals and leaves concurrent alternatives isolated', async () => {
        const workspace = await f.create();
        const prepare = async (actor: string) => {
            const run = await workspace.fork({ actor, ...request() }); const agent = workspace.agent(run.id);
            const plan = await agent.plan(program({ description: actor }), request()); await agent.apply(plan.id, request());
            const proposal = await agent.submit(request()); return { proposal, approval: await workspace.approve(proposal.id, reviewer()) };
        };
        const a = await prepare('first'); const b = await prepare('second');
        await workspace.promote(a.approval.id, reviewer());
        expect((await workspace.review(b.proposal.id)).stale).toBe(true);
        await expect(workspace.promote(b.approval.id, reviewer())).rejects.toMatchObject({ code: 'STRINGBASE_CONFLICT' });
        await expect(workspace.approve(b.proposal.id, reviewer())).rejects.toMatchObject({ code: 'STRINGBASE_CONFLICT' });
    });

    it('revokes old runs, receipts and approvals when policy changes', async () => {
        const workspace = await f.create(); const run = await workspace.fork({ actor: 'agent', ...request() }); const agent = workspace.agent(run.id);
        const req = request(); const plan = await agent.plan(program(), req); const applied = await agent.apply(plan.id, request());
        const proposal = await agent.submit(request()); const approval = await workspace.approve(proposal.id, reviewer());
        await workspace.setPolicy({ ...policy, version: 'catalog-2', write: [] }, reviewer());
        await expect(agent.query(queryProgram)).rejects.toMatchObject({ code: 'STRINGBASE_CAPABILITY_DENIED' });
        await expect(agent.plan(program(), req)).rejects.toMatchObject({ code: 'STRINGBASE_CAPABILITY_DENIED' });
        await expect(workspace.promote(approval.id, reviewer())).rejects.toMatchObject({ code: 'STRINGBASE_CAPABILITY_DENIED' });
        expect(await workspace.replay(applied.id)).toMatchObject({ matches: true });
    });

    it('supports host import, rejection, discard, pagination and readonly use', async () => {
        const workspace = await f.create(); const initial = await workspace.describe();
        const run = await workspace.fork({ actor: 'agent', ...request() }); const agent = workspace.agent(run.id);
        const plan = await agent.plan(program({ category: 'tools', tags: ['new'] }), request()); await agent.apply(plan.id, request());
        expect(await agent.diff({ limit: 1 })).toMatchObject({ total: 2, nextOffset: 1 });
        expect(await agent.history()).toMatchObject({ total: 1 });
        const proposal = await agent.submit(request()); expect((await workspace.reject(proposal.id, reviewer())).status).toBe('rejected');
        const disposable = await workspace.fork({ actor: 'discard', ...request() });
        expect((await workspace.agent(disposable.id).discard(request())).status).toBe('discarded');
        const imported = await workspace.importSnapshot({ data: { products: [{ id: 'new', description: 'New source' }] }, sourceRevision: 'source-2', expectedRevision: initial.revision, actor: 'host', ...request() });
        expect(imported.kind).toBe('import');
        const reader = await f.open('readonly'); expect((await reader.describe()).revision).toBe(imported.id);
        await expect(reader.fork({ actor: 'x', ...request() })).rejects.toMatchObject({ code: 'STRINGBASE_READ_ONLY' });
        await expect(workspace.exportChanges(imported.id)).rejects.toMatchObject({ code: 'STRINGBASE_INVALID_STATE' });
        await expect(workspace.revert(imported.id, reviewer())).rejects.toMatchObject({ code: 'STRINGBASE_INVALID_STATE' });
    });

    it('bounds matches, operations, output and query pages', async () => {
        const workspace = await f.create({ policy: { ...policy, maxMatches: 1, maxResults: 1 } });
        const run = await workspace.fork({ actor: 'agent', ...request() }); const agent = workspace.agent(run.id);
        expect(await agent.query(queryProgram)).toMatchObject({ documents: [data.products[0]], nextSkip: 1 });
        await expect(agent.plan({ ...queryProgram, mutation: { op: 'merge', value: { description: 'all' } } }, request())).rejects.toMatchObject({ code: 'STRINGBASE_LIMIT_EXCEEDED' });
        await expect(agent.plan({ ...program(), limits: { maxOperations: 0 } }, request())).rejects.toMatchObject({ code: 'STRINGBASE_LIMIT_EXCEEDED' });
    });

    it('validates data, options, policy and the supported deterministic program subset', async () => {
        await expect(f.create({ data: { products: [{ id: 'x', description: 3 }] } as never })).rejects.toMatchObject({ code: 'STRINGBASE_INVALID_DATA' });
        await expect(f.create({ data: { products: [{ id: 'x' }] } })).rejects.toMatchObject({ code: 'STRINGBASE_VALIDATION_FAILED' });
        await expect(Workspace.open({ directory: f.filepath, mode: 'invalid' } as never)).rejects.toMatchObject({ code: 'STRINGBASE_INVALID_OPTIONS' });
        expect(() => validatePolicy({ ...policy, extra: true })).toThrow();
        expect(() => validatePolicy({ ...policy, read: ['not-a-pointer'] })).toThrow();
        expect(() => validateProgram({ ...queryProgram, query: { version: 1, steps: [{ op: 'each' }] } }, false)).toThrow();
        expect(() => validateProgram({ ...program(), mutation: { op: 'remove' } }, true)).toThrow();
        expect(() => validateProgram({ ...queryProgram, query: { version: 1, steps: [{ op: 'where', predicate: { op: 'exists', value: { op: 'probability', judgment: 'x', input: { op: 'current' }, outcome: true } } }] } }, false)).toThrow();
    });
});
