import { parseArgs } from 'node:util';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Workspace } from './agent/workspace';
import { StringbaseError, fail } from './errors';
import { databaseData } from './model';
import { parseValue } from './storage/codec';
import type { AgentPolicy, AgentProgram } from './agent/types';

const help = 'Usage: stringbase workspace <command> <directory> [options]\n\n'
    + 'Commands: init, import, describe, fork, query, plan, apply, diff, submit, discard,\n'
    + '          review, approve, promote, reject, export, history, receipt, replay, revert, policy\n\n'
    + 'init/import: --snapshot <Deon or JSON file> --policy <JSON file> (init only)\n'
    + '             --source-revision <revision> --actor <host actor>\n'
    + 'fork: --actor <agent> [--label <label>]\n'
    + 'query/plan: --run <id> --program <JSON file>\n'
    + 'apply: --run <id> --plan <id>\n'
    + 'diff/submit/discard: --run <id>\n'
    + 'review/approve/reject: --proposal <id>\n'
    + 'promote: --approval <id>\n'
    + 'approve/promote/reject/revert/policy: --reviewer <trusted reviewer>\n'
    + 'policy: --policy <JSON file>\n'
    + 'receipt: --request-id <id>\n'
    + 'export/replay/revert: --revision <id> (export defaults to accepted head)\n'
    + 'Mutations accept --request-id <id>; retain it when retrying a command.\n'
    + 'import requires --expected-revision; fork/query can also pin it.\n'
    + 'diff/review/history accept --offset <n> --limit <n>.\n'
    + 'JSON snapshots must contain only strings, lists, and maps.\n';

async function load(filename: string, json = true): Promise<unknown> {
    const handle = await open(filename, 'r');
    try {
        if ((await handle.stat()).size > 64 * 1024 * 1024) fail('LIMIT_EXCEEDED', 'Input exceeds 64 MiB.');
        const chunks: Buffer[] = [];
        let size = 0;
        while (true) {
            const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, 64 * 1024 * 1024 - size + 1));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            size += bytesRead;
            if (size > 64 * 1024 * 1024) fail('LIMIT_EXCEEDED', 'Input exceeds 64 MiB.');
            chunks.push(buffer.subarray(0, bytesRead));
        }
        const source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
        return json || filename.endsWith('.json') ? JSON.parse(source) as unknown : parseValue(source, filename);
    } finally { await handle.close(); }
}

export async function workspaceMain(args: readonly string[]): Promise<number> {
    let workspace: Workspace | undefined;
    let requestId: string | undefined;
    try {
        const { values, positionals } = parseArgs({ args: [...args], allowPositionals: true, options: {
            help: { type: 'boolean', short: 'h' }, snapshot: { type: 'string' }, policy: { type: 'string' },
            'source-revision': { type: 'string' }, actor: { type: 'string' }, label: { type: 'string' },
            run: { type: 'string' }, program: { type: 'string' }, plan: { type: 'string' }, proposal: { type: 'string' }, approval: { type: 'string' },
            reviewer: { type: 'string' }, revision: { type: 'string' }, 'expected-revision': { type: 'string' }, 'request-id': { type: 'string' },
            offset: { type: 'string' }, limit: { type: 'string' },
        } });
        if (values.help || !positionals.length) { process.stdout.write(help); return 0; }
        const [command, directory] = positionals;
        const specs: Record<string, readonly string[]> = {
            init: ['snapshot', 'policy', 'source-revision', 'actor'], import: ['snapshot', 'source-revision', 'actor', 'expected-revision', 'request-id'],
            describe: ['run'], fork: ['actor', 'label', 'expected-revision', 'request-id'], query: ['run', 'program', 'expected-revision'],
            plan: ['run', 'program', 'request-id'], apply: ['run', 'plan', 'request-id'], diff: ['run', 'offset', 'limit'],
            submit: ['run', 'request-id'], discard: ['run', 'request-id'], review: ['proposal', 'offset', 'limit'],
            approve: ['proposal', 'reviewer', 'request-id'], promote: ['approval', 'reviewer', 'request-id'], reject: ['proposal', 'reviewer', 'request-id'],
            export: ['revision'], history: ['run', 'offset', 'limit'], receipt: ['request-id'], replay: ['revision'],
            revert: ['revision', 'reviewer', 'request-id'], policy: ['policy', 'reviewer', 'request-id'],
        };
        if (!command || !directory || positionals.length !== 2 || !Object.hasOwn(specs, command) || Object.keys(values).some(key => !specs[command]!.includes(key))) fail('INVALID_OPTIONS', 'Unknown command, extra arguments, or unsupported options.');
        const required = (key: keyof typeof values): string => { const value = values[key]; if (typeof value !== 'string' || !value.trim()) fail('INVALID_OPTIONS', '--' + key + ' is required.'); return value; };
        const request = { requestId: values['request-id'] ?? randomUUID() };
        requestId = request.requestId;
        const reviewer = () => ({ ...request, reviewer: required('reviewer') });
        const number = (key: 'offset' | 'limit') => { const value = required(key); if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail('INVALID_OPTIONS', 'Invalid pagination.'); return Number(value); };
        const page = { ...(values.offset === undefined ? {} : { offset: number('offset') }), ...(values.limit === undefined ? {} : { limit: number('limit') }) };
        const readonly = ['describe', 'query', 'diff', 'review', 'export', 'history', 'receipt', 'replay'].includes(command);
        workspace = command === 'init' ? await Workspace.create({ directory, data: databaseData(await load(required('snapshot'), false)), policy: await load(required('policy')) as AgentPolicy,
            sourceRevision: required('source-revision'), actor: required('actor') }) : await Workspace.open({ directory, mode: readonly ? 'readonly' : 'readwrite' });
        const agent = () => workspace!.agent(required('run'));
        let result: unknown;
        switch (command) {
            case 'init': result = await workspace.describe(); break;
            case 'import': result = await workspace.importSnapshot({ data: databaseData(await load(required('snapshot'), false)), sourceRevision: required('source-revision'), actor: required('actor'), expectedRevision: required('expected-revision'), ...request }); break;
            case 'describe': result = values.run ? await agent().describe() : await workspace.describe(); break;
            case 'fork': result = await workspace.fork({ actor: required('actor'), ...request, ...(values.label ? { label: values.label } : {}), ...(values['expected-revision'] ? { expectedRevision: values['expected-revision'] } : {}) }); break;
            case 'query': result = await agent().query(await load(required('program')) as AgentProgram, values['expected-revision'] ? { expectedRevision: values['expected-revision'] } : {}); break;
            case 'plan': result = await agent().plan(await load(required('program')) as AgentProgram, request); break;
            case 'apply': result = await agent().apply(required('plan'), request); break;
            case 'diff': result = await agent().diff(page); break;
            case 'submit': result = await agent().submit(request); break;
            case 'discard': result = await agent().discard(request); break;
            case 'review': result = await workspace.review(required('proposal'), page); break;
            case 'approve': result = await workspace.approve(required('proposal'), reviewer()); break;
            case 'promote': result = await workspace.promote(required('approval'), reviewer()); break;
            case 'reject': result = await workspace.reject(required('proposal'), reviewer()); break;
            case 'export': result = await workspace.exportChanges(values.revision); break;
            case 'history': result = values.run ? await agent().history(page) : await workspace.history(page); break;
            case 'receipt': result = await workspace.receipt(required('request-id')); break;
            case 'replay': result = await workspace.replay(required('revision')); break;
            case 'revert': result = await workspace.revert(required('revision'), reviewer()); break;
            case 'policy': result = await workspace.setPolicy(await load(required('policy')), reviewer()); break;
        }
        process.stdout.write(JSON.stringify({ ok: true, result, ...(['init', ...['describe', 'query', 'diff', 'review', 'export', 'history', 'receipt', 'replay']].includes(command) ? {} : { requestId: request.requestId }) }, null, 2) + '\n');
        return 0;
    } catch (cause) {
        const code = cause instanceof StringbaseError ? cause.code : 'STRINGBASE_INVALID_DATA';
        process.stderr.write(JSON.stringify({ ok: false, ...(requestId ? { requestId } : {}), error: { code, message: cause instanceof Error ? cause.message : String(cause) } }) + '\n');
        return /INVALID|VALIDATION|CAPABILITY|LIMIT/.test(code) ? 2 : 1;
    } finally { if (workspace) await workspace.close(); }
}
