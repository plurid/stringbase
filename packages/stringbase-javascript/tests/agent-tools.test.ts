import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { agentProgramSchema, agentTools, createAgentTools, validatePolicy, validateProgram } from '../source/agent';
import { policy, program, queryProgram, request, workspaceFixture } from './agent-helpers';

describe('agent tool boundary', () => {
    const f = workspaceFixture();
    it('advertises schemas matching the supported deterministic query and merge subset', () => {
        const ajv = new Ajv2020({ strict: false }); const schema = ajv.compile(agentProgramSchema);
        for (const candidate of [queryProgram, program(), { ...queryProgram, fields: ['id'] }, { ...program(), limits: { maxMatches: 0 } }]) {
            expect(schema(candidate), JSON.stringify(schema.errors)).toBe(true);
            expect(() => validateProgram(candidate, Object.hasOwn(candidate, 'mutation'))).not.toThrow();
        }
        for (const candidate of [
            { ...program(), mutation: { op: 'remove' } }, { ...program(), mutation: { op: 'merge', value: { id: 'x' } } },
            { ...program(), fields: ['id'] }, { ...program(), mutation: { op: 'merge', value: { count: 3 } } },
            { ...queryProgram, query: { version: 1, steps: [{ op: 'each' }] } },
            { ...queryProgram, query: { version: 1, steps: [{ op: 'where', predicate: { op: 'exists', value: { op: 'probability', judgment: 'x', input: { op: 'current' }, outcome: true } } }] } },
        ]) {
            expect(schema(candidate)).toBe(false);
            expect(() => validateProgram(candidate, Object.hasOwn(candidate, 'mutation'))).toThrow();
        }
        for (const tool of agentTools) expect(() => ajv.compile(tool.inputSchema)).not.toThrow();
        expect(agentTools.some(tool => /approve|promote|export|policy/.test(tool.name))).toBe(false);
    });

    it('executes the transport-neutral agent workflow with structured responses', async () => {
        const workspace = await f.create(); const adapter = createAgentTools(workspace, { actor: 'catalog' });
        const call = async (name: string, args: object = {}) => {
            const response = await adapter.call('stringbase_' + name, args);
            expect(response.isError, JSON.stringify(response.structuredContent)).toBe(false);
            expect(JSON.parse(response.content[0]!.text)).toEqual(response.structuredContent);
            return response.structuredContent.result as Record<string, unknown>;
        };
        expect(await call('describe')).not.toHaveProperty('directory');
        const run = await call('fork', { ...request(), label: 'catalog update' }); const runId = run.id;
        expect(await call('describe', { runId })).toHaveProperty('revision');
        expect(await call('query', { runId, program: queryProgram, expectedRevision: run.head })).toHaveProperty('documents');
        const planned = await call('plan', { runId, program: program(), ...request() });
        const applied = await call('apply', { runId, planId: planned.id, ...request() });
        expect(await call('diff', { runId, offset: 0, limit: 10 })).toMatchObject({ total: 1 });
        expect(await call('history', { runId })).toMatchObject({ total: 1 });
        expect(await call('submit', { runId, ...request() })).toHaveProperty('diffHash');
        expect((await workspace.describe()).revision).not.toBe(applied.id);
        const disposable = await call('fork', request());
        expect(await call('discard', { runId: disposable.id, ...request() })).toMatchObject({ status: 'discarded' });
    });

    it('binds actor and granted runs outside model arguments and denies host operations', async () => {
        const workspace = await f.create(); const other = await workspace.fork({ actor: 'other', ...request() });
        const adapter = createAgentTools(workspace, { actor: 'agent', runIds: [other.id] });
        for (const [name, args] of [
            ['stringbase_approve', {}], ['stringbase_promote', {}], ['stringbase_query', { runId: other.id, program: queryProgram }],
            ['stringbase_query', { runId: 'guessed', program: queryProgram }], ['stringbase_fork', { actor: 'other', ...request() }],
            ['stringbase_describe', null], ['stringbase_plan', { program: program() }],
        ] as const) expect((await adapter.call(name, args)).isError).toBe(true);
        const own = await workspace.fork({ actor: 'agent', ...request() });
        const restored = createAgentTools(workspace, { actor: 'agent', runIds: [own.id] });
        expect((await restored.call('stringbase_query', { runId: own.id, program: queryProgram })).isError).toBe(false);
        await workspace.close();
        expect((await restored.call('stringbase_describe')).structuredContent).toMatchObject({ ok: false, error: { code: 'STRINGBASE_CLOSED', retryable: false } });
    });

    it('bounds tool input, policy and field validation cases', async () => {
        for (const invalid of [
            { ...policy, maxMatches: -1 }, { ...policy, maxResults: 10001 }, { ...policy, maxOutputBytes: 1 },
            { ...policy, read: [''] }, { ...policy, read: ['x'] }, { ...policy, schema: { products: { x: { kind: 'number' } } } },
            { ...policy, schema: { products: { x: { kind: 'string', required: 'yes' } } } },
            { ...policy, schema: { products: { x: { kind: 'string', minLength: 4, maxLength: 2 } } } },
            { ...policy, schema: { products: { x: { kind: 'string', enum: [3] } } } },
        ]) expect(() => validatePolicy(invalid)).toThrow();
        for (const invalid of [
            { ...queryProgram, version: 2 }, { ...queryProgram, fields: [] }, { ...queryProgram, fields: [3] },
            { ...queryProgram, limits: { maxEvaluations: 1 } }, { ...queryProgram, limits: { maxMatches: -1 } },
        ]) expect(() => validateProgram(invalid, false)).toThrow();
        const workspace = await f.create({ policy: { ...policy, schema: { ...policy.schema, products: { ...policy.schema.products, attributes: { kind: 'map', required: false } } } } });
        const run = await workspace.fork({ actor: 'agent', ...request() });
        const adapter = createAgentTools(workspace, { actor: 'agent', runIds: [run.id] });
        const conflict = await adapter.call('stringbase_query', { runId: run.id, program: queryProgram, expectedRevision: 'wrong' });
        expect(conflict.structuredContent).toMatchObject({ error: { code: 'STRINGBASE_CONFLICT', retryable: true } });
        expect((await adapter.call('stringbase_diff', { runId: run.id, limit: 0 })).isError).toBe(true);
    });
});
