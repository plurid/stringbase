import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Workspace } from '@plurid/stringbase/agent';

const cli = new URL('../distribution/cli.mjs', import.meta.url).pathname;
const policy = { version: '1', read: ['/products/*'], write: ['/products/*/description'], schema: { products: { description: { kind: 'string', required: true }, sku: { kind: 'string' } } } };
const query = { version: 1, collection: 'products', query: { version: 1, steps: [] } };
const edit = { ...query, mutation: { op: 'merge', value: { description: 'Reviewed copy' } } };

test('stdio SDK client completes the isolated workflow; host operations stay unavailable', { timeout: 30_000 }, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'stringbase-mcp-')); const directory = join(temporary, 'workspace');
    const initial = await Workspace.create({ directory, data: { products: [{ id: '01', description: 'Old copy', sku: '01' }] }, policy, sourceRevision: 'source-1', actor: 'host' });
    const accepted = (await initial.describe()).revision; await initial.close();
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, directory, '--actor', 'catalog'], stderr: 'pipe' });
    const client = new Client({ name: 'stringbase-test', version: '1' });
    try {
        await client.connect(transport);
        const tools = await client.listTools();
        assert.equal(tools.tools.length, 9);
        assert.equal(tools.tools.some(tool => /approve|promote|export|policy/.test(tool.name)), false);
        const invoke = async (name, args = {}) => {
            const result = await client.callTool({ name: 'stringbase_' + name, arguments: args });
            assert.equal(result.isError, false, JSON.stringify(result));
            assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
            return result.structuredContent.result;
        };
        const described = await invoke('describe'); assert.equal(described.revision, accepted); assert.equal('directory' in described, false);
        const run = await invoke('fork', { requestId: 'fork-1', label: 'catalog enrichment' });
        assert.equal((await invoke('fork', { requestId: 'fork-1', label: 'catalog enrichment' })).id, run.id);
        assert.equal((await invoke('query', { runId: run.id, program: query })).documents[0].description, 'Old copy');
        const forbidden = await client.callTool({ name: 'stringbase_plan', arguments: { runId: run.id, program: { ...edit, mutation: { op: 'merge', value: { sku: 'changed' } } }, requestId: 'forbidden' } });
        assert.equal(forbidden.structuredContent.error.code, 'STRINGBASE_CAPABILITY_DENIED');
        const planned = await invoke('plan', { runId: run.id, program: edit, requestId: 'plan-1' });
        await invoke('apply', { runId: run.id, planId: planned.id, requestId: 'apply-1' });
        assert.equal((await invoke('diff', { runId: run.id })).total, 1);
        const proposal = await invoke('submit', { runId: run.id, requestId: 'submit-1' });
        assert.equal((await client.callTool({ name: 'stringbase_promote', arguments: { proposalId: proposal.id } })).isError, true);
        const unknown = await client.callTool({ name: 'stringbase_query', arguments: { runId: 'other-run', program: query } });
        assert.equal(unknown.structuredContent.error.code, 'STRINGBASE_CAPABILITY_DENIED');
        await client.close();
        // The transport must release writer ownership when its stdin closes.
        const workspace = await Workspace.open({ directory });
        try {
            assert.equal((await workspace.describe()).revision, accepted);
            assert.equal((await workspace.review(proposal.id)).total, 1);
            const approval = await workspace.approve(proposal.id, { reviewer: 'human', requestId: 'approve' });
            await workspace.promote(approval.id, { reviewer: 'human', requestId: 'promote' });
            assert.equal((await workspace.exportChanges()).changes[0].after, 'Reviewed copy');
        } finally { await workspace.close(); }
    } finally { await client.close(); await rm(temporary, { recursive: true, force: true }); }
});

test('CLI rejects missing host configuration and keeps failures off stdout', () => {
    const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0); assert.match(help.stdout, /host-selected/);
    const invalid = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
    assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.match(invalid.stderr, /workspace directory/);
});
