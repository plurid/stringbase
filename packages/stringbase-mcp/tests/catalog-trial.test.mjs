import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace, createAgentTools } from '@plurid/stringbase/agent';
import { codexArguments, runCodexTrial } from '../../../examples/catalog/codex-trial-lib.mjs';

async function simulateAgent(context) {
    const workspace = await Workspace.open({ directory: context.workspace });
    const adapter = createAgentTools(workspace, { actor: 'catalog-codex', runIds: [context.runId] });
    const events = [];
    const invoke = async (name, arguments_) => {
        const response = await adapter.call('stringbase_' + name, arguments_);
        assert.equal(response.isError, false, JSON.stringify(response.structuredContent));
        events.push({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'stringbase', tool: 'stringbase_' + name, status: 'completed' } });
        return response.structuredContent.result;
    };
    try {
        const runId = context.runId;
        await invoke('describe', { runId });
        const records = await invoke('query', { runId, program: { version: 1, collection: 'products', query: { version: 1, steps: [] } } });
        for (const product of records.documents) {
            const program = { version: 1, collection: 'products', query: { version: 1, steps: [{ op: 'where', predicate: { op: 'eq', left: { op: 'field', path: ['id'] }, right: { op: 'literal', value: product.id } } }] }, mutation: { op: 'merge', value: { description: 'A ' + product.title.toLowerCase() + '.' } } };
            const plan = await invoke('plan', { runId, program, requestId: randomUUID() });
            await invoke('apply', { runId, planId: plan.id, requestId: randomUUID() });
        }
        await invoke('diff', { runId });
        const proposal = await invoke('submit', { runId, requestId: randomUUID() });
        return { events, message: { runId, proposalId: proposal.id, summary: 'Simulated tool workflow; no model was called.' } };
    } finally { await workspace.close(); }
}

test('trial harness preserves a pending proposal and accurately labels simulated execution', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'stringbase-trial-test-'));
    try {
        const report = await runCodexTrial({ outputDirectory: join(temporary, 'trial'), execute: simulateAgent });
        assert.equal(report.status, 'ready_for_review'); assert.equal(report.liveModel, false);
        assert.equal(report.changes.length, 2); assert.equal(Object.values(report.checks).every(Boolean), true);
        const saved = JSON.parse(await readFile(join(report.directory, 'report.json'), 'utf8')); assert.deepEqual(saved, report);
        const review = await readFile(join(report.directory, 'review.md'), 'utf8'); assert.match(review, /A desk lamp/); assert.match(review, /human review/);
        const workspace = await Workspace.open({ directory: join(report.directory, 'workspace') });
        try { assert.equal((await workspace.getRun(report.runId)).status, 'submitted'); assert.equal((await workspace.history()).items[0].kind, 'import'); }
        finally { await workspace.close(); }
    } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('trial rejects false final IDs and preserves evidence of executor failures', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'stringbase-trial-test-'));
    try {
        const wrong = await runCodexTrial({ outputDirectory: join(temporary, 'wrong'), execute: async context => { const result = await simulateAgent(context); result.message.runId = 'another-run'; return result; } });
        assert.equal(wrong.status, 'failed'); assert.match(wrong.error, /granted run/);
        const failed = await runCodexTrial({ outputDirectory: join(temporary, 'failed'), execute: async () => { throw new Error('CLI unavailable'); } });
        assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'CLI unavailable');
        assert.match(await readFile(join(failed.directory, 'review.md'), 'utf8'), /CLI unavailable/);
        await assert.rejects(runCodexTrial({ timeoutMs: 0 }), /timeoutMs/);
    } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('Codex invocation uses per-run MCP configuration, bounded permissions and literal arguments', () => {
    const args = codexArguments({ workspace: '/tmp/a workspace', workdir: '/tmp/agent', runId: 'run', output: '/tmp/final.json', schema: '/tmp/schema.json' });
    assert.ok(args.includes('--ignore-user-config')); assert.ok(args.includes('--ephemeral'));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(args.includes('features.shell_tool=false')); assert.ok(args.includes('features.multi_agent=false'));
    assert.ok(args.includes('mcp_servers.stringbase.required=true'));
    assert.ok(args.some(value => value.startsWith('mcp_servers.stringbase.args=') && value.includes('/tmp/a workspace')));
    assert.equal(args.includes('--model'), false); assert.equal(args.some(value => value.includes('dangerously')), false);
});
