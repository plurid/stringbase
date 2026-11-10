import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../../packages/stringbase-javascript/distribution/agent.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const server = join(root, 'packages/stringbase-mcp/distribution/cli.mjs');
const allowedTools = ['describe', 'query', 'plan', 'apply', 'diff', 'history', 'submit'].map(name => 'stringbase_' + name);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const saveJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

export function codexArguments({ workspace, workdir, runId, output, schema, model }) {
    const settings = {
        approval_policy: 'never', web_search: 'disabled',
        'features.shell_tool': false, 'features.unified_exec': false, 'features.multi_agent': false,
        'features.apps': false, 'features.plugins': false, 'features.hooks': false,
        'features.browser_use': false,
        'features.computer_use': false, 'features.image_generation': false, 'features.view_image': false,
        'mcp_servers.stringbase.command': process.execPath,
        'mcp_servers.stringbase.args': [server, workspace, '--actor', 'catalog-codex', '--run', runId],
        'mcp_servers.stringbase.required': true,
        'mcp_servers.stringbase.enabled_tools': allowedTools,
        'mcp_servers.stringbase.default_tools_approval_mode': 'auto',
    };
    return ['exec', '--strict-config', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
        '--sandbox', 'read-only', '--cd', workdir, '--json', '--color', 'never',
        '--output-schema', schema, '--output-last-message', output,
        ...(model ? ['--model', model] : []),
        ...Object.entries(settings).flatMap(([key, value]) => ['--config', key + '=' + JSON.stringify(value)]), '-'];
}

/** Executes the actual CLI; tests supply an explicitly simulated executor instead. */
export async function executeCodex(context) {
    const events = []; const errors = []; let outputBytes = 0; let stderrBytes = 0; let timedOut = false; let overflow = false; let cancelled = false;
    const child = spawn('codex', context.args, { cwd: context.workdir, stdio: ['pipe', 'pipe', 'pipe'] });
    let forceStop;
    const stop = () => { child.kill('SIGTERM'); forceStop ??= setTimeout(() => child.kill('SIGKILL'), 5000); };
    const cancel = () => { cancelled = true; stop(); };
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    const timer = setTimeout(() => { timedOut = true; stop(); }, context.timeoutMs);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
        outputBytes += Buffer.byteLength(line);
        if (outputBytes > 16 * 1024 * 1024) { overflow = true; stop(); return; }
        try {
            const event = JSON.parse(line); events.push(event);
            if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') process.stderr.write('Codex: ' + event.item.tool + ' (' + event.item.status + ')\n');
        } catch { events.push({ type: 'unparsed_output', text: line }); }
    });
    child.stderr.on('data', chunk => {
        if (stderrBytes < 1024 * 1024) errors.push(chunk.subarray(0, 1024 * 1024 - stderrBytes));
        stderrBytes += chunk.length;
    });
    child.stdin.on('error', () => { /* A failed startup may close stdin before accepting the prompt. */ });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    child.stdin.end(context.prompt);
    let status;
    try { status = await exited; }
    finally {
        clearTimeout(timer); clearTimeout(forceStop); lines.close();
        process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
        await writeFile(join(context.directory, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
        await writeFile(join(context.directory, 'stderr.log'), Buffer.concat(errors), { mode: 0o600 });
    }
    if (timedOut) throw new Error('Codex exceeded the trial timeout; inspect the preserved workspace and logs.');
    if (cancelled) throw new Error('Codex trial was cancelled; inspect the preserved workspace and logs.');
    if (overflow) throw new Error('Codex output exceeded the trial budget.');
    if (status.code !== 0) throw new Error('Codex exited with ' + (status.signal ?? status.code) + '; see stderr.log and events.jsonl.');
    return { events, message: await readJson(context.output) };
}

export function renderReview(report) {
    const lines = ['# Catalog trial: human review', '', 'Status: ' + report.status, '',
        'Run: ' + report.runId, 'Proposal: ' + (report.proposalId ?? 'unavailable'),
        'Live model: ' + report.liveModel, '',
        report.checks?.acceptedRevisionUnchanged === true ? 'The accepted revision was verified unchanged. Publication requires a separate host decision.' : 'Accepted state has not been verified unchanged. Inspect the saved workspace before any reviewer decision.', '',
        '## Proposed changes', ''];
    for (const change of report.changes ?? []) lines.push('Product ' + JSON.stringify(change.id) + ', field ' + JSON.stringify(change.field), '',
        '    Before: ' + JSON.stringify(change.before), '    After:  ' + JSON.stringify(change.after), '');
    lines.push('## Checks', '');
    for (const [key, value] of Object.entries(report.checks ?? {})) lines.push('- ' + key + ': ' + value);
    lines.push('', 'Factual quality and usefulness require human judgment. Passing these checks establishes workflow and schema compliance.', '');
    if (report.error) lines.push('Error: ' + report.error, '');
    return lines.join('\n');
}

export async function runCodexTrial({ outputDirectory, model, timeoutMs = 180_000, execute = executeCodex } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new Error('timeoutMs must be between 1000 and 600000.');
    const directory = outputDirectory ? resolve(outputDirectory) : await mkdtemp(join(tmpdir(), 'stringbase-codex-'));
    if (outputDirectory) await mkdir(directory, { mode: 0o700 });
    const workdir = join(directory, 'agent'); await mkdir(workdir, { mode: 0o700 });
    const workspacePath = join(directory, 'workspace'); const output = join(directory, 'last-message.json'); const schema = join(directory, 'response-schema.json');
    const data = await readJson(new URL('snapshot.json', import.meta.url));
    const policy = { ...await readJson(new URL('policy.json', import.meta.url)), version: 'catalog-codex-trial-1',
        write: ['/products/*/description'], maxMatches: 2, maxOperations: 4, maxResults: 10 };
    const started = performance.now(); let workspace;
    const report = { version: 1, status: 'failed', liveModel: execute === executeCodex, directory, runId: '', changes: [], checks: {} };
    try {
        workspace = await Workspace.create({ directory: workspacePath, data, policy, sourceRevision: 'catalog-codex-trial-source-1', actor: 'catalog-trial-host', maxWorkspaceBytes: 8 * 1024 * 1024 });
        const accepted = (await workspace.describe()).revision;
        const run = await workspace.fork({ actor: 'catalog-codex', label: 'Rewrite two catalog descriptions', requestId: randomUUID() });
        report.runId = run.id;
        await workspace.close(); workspace = undefined;
        await saveJson(schema, { type: 'object', properties: { runId: { type: 'string' }, proposalId: { type: 'string' }, summary: { type: 'string' } }, required: ['runId', 'proposalId', 'summary'], additionalProperties: false });
        const prompt = 'You are a catalog enrichment agent. Use only the stringbase MCP tools. This is a data task.\n'
            + 'The host already created and granted run ' + run.id + '. Use that run; do not create another.\n'
            + 'Call describe to discover its schema and permissions, then query the products.\n'
            + 'Rewrite the description of BOTH products as a concise complete sentence, using only their supplied title and existing description.\n'
            + 'Preserve facts. Do not invent features, materials, adjustability, specifications, or performance claims.\n'
            + 'Change only description. Keep IDs, titles, categories, and tags intact. All stored scalar values are strings.\n'
            + 'Build version 1 collection-scoped Loque programs, preview with plan, check findings, then apply valid plans in the run.\n'
            + 'Use a unique UUID requestId for each mutation; reuse it only for an identical retry.\n'
            + 'Inspect the final diff, then submit the run for human review. Stop after submission.\n'
            + 'Return JSON containing the granted runId, the actual proposalId returned by submit, and a short summary.';
        await writeFile(join(directory, 'prompt.txt'), prompt + '\n', { mode: 0o600 });
        const context = { directory, workdir, workspace: workspacePath, runId: run.id, output, schema, model, prompt, timeoutMs };
        const result = await execute({ ...context, args: codexArguments(context) });
        workspace = await Workspace.open({ directory: workspacePath });
        if (!result.message || result.message.runId !== run.id || typeof result.message.proposalId !== 'string' || !result.message.proposalId.trim()) throw new Error('Agent response does not identify the granted run and a proposal. ' + (result.message?.summary ?? ''));
        const current = await workspace.getRun(run.id); const review = await workspace.review(result.message.proposalId, { limit: 100 });
        const events = result.events ?? [];
        const calls = events.filter(event => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call').map(event => event.item);
        const forbidden = events.filter(event => event.type.startsWith('item.') && ['command_execution', 'file_change', 'web_search'].includes(event.item?.type));
        const expectedIds = new Set(data.products.map(product => product.id));
        report.checks = {
            acceptedRevisionUnchanged: (await workspace.describe()).revision === accepted,
            runSubmitted: current.status === 'submitted', proposalBelongsToRun: review.proposal.runId === run.id,
            schemaValid: review.findings.length === 0, completeReview: review.nextOffset === null,
            onlyDescriptionChanges: review.changes.every(change => change.collection === 'products' && change.field === 'description' && typeof change.after === 'string' && expectedIds.has(change.id)),
            bothProductsChanged: new Set(review.changes.map(change => change.id)).size === expectedIds.size,
            usedStringbaseTools: calls.length > 0 && calls.every(call => call.server === 'stringbase' && allowedTools.includes(call.tool)),
            noOtherExecution: forbidden.length === 0,
        };
        report.proposalId = review.proposal.id; report.changes = review.changes; report.summary = result.message.summary;
        report.toolCalls = calls.map(call => ({ tool: call.tool, status: call.status }));
        report.usage = events.findLast(event => event.type === 'turn.completed')?.usage ?? null;
        report.status = Object.values(report.checks).every(Boolean) ? 'ready_for_review' : 'failed';
        if (report.status === 'failed') report.error = 'One or more trial checks failed; inspect the saved report and events.';
    } catch (error) { report.error = error instanceof Error ? error.message : String(error); }
    finally {
        if (workspace) {
            try { await workspace.close(); }
            catch (error) { report.status = 'failed'; report.error = (report.error ? report.error + ' ' : '') + 'Workspace close failed: ' + String(error); }
        }
        report.elapsedMs = Math.round(performance.now() - started);
        await saveJson(join(directory, 'report.json'), report);
        await writeFile(join(directory, 'review.md'), renderReview(report), { mode: 0o600 });
    }
    return report;
}
