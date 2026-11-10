import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { data, policy, program, queryProgram, workspaceFixture } from './agent-helpers';

describe('workspace CLI', () => {
    const f = workspaceFixture();
    const cli = new URL('../distribution/cli.mjs', import.meta.url).pathname;
    it('runs catalog changes through explicit host review and publication', async () => {
        const snapshot = join(f.directory, 'data.json'); const rules = join(f.directory, 'policy.json'); const edit = join(f.directory, 'edit.json'); const query = join(f.directory, 'query.json');
        await writeFile(snapshot, JSON.stringify(data)); await writeFile(rules, JSON.stringify(policy)); await writeFile(edit, JSON.stringify(program())); await writeFile(query, JSON.stringify(queryProgram));
        const run = (command: string, ...args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, 'workspace', command, f.filepath, ...args], { encoding: 'utf8' })).result;
        expect(run('init', '--snapshot', snapshot, '--policy', rules, '--source-revision', 'source-1', '--actor', 'importer')).toHaveProperty('revision');
        const fork = run('fork', '--actor', 'agent', '--request-id', 'cli-fork');
        expect(run('fork', '--actor', 'agent', '--request-id', 'cli-fork').id).toBe(fork.id);
        const read = run('query', '--run', fork.id, '--program', query, '--expected-revision', fork.head);
        expect(read.documents).toEqual(data.products);
        const planned = run('plan', '--run', fork.id, '--program', edit);
        const applied = run('apply', '--run', fork.id, '--plan', planned.id, '--request-id', 'cli-apply');
        expect(run('receipt', '--request-id', 'cli-apply').result.id).toBe(applied.id);
        expect(run('diff', '--run', fork.id, '--limit', '1')).toHaveProperty('changes');
        expect(run('history', '--run', fork.id)).toMatchObject({ total: 1 });
        expect(run('replay', '--revision', applied.id)).toMatchObject({ matches: true });
        const proposal = run('submit', '--run', fork.id);
        expect(run('review', '--proposal', proposal.id, '--offset', '0')).toMatchObject({ stale: false });
        const approval = run('approve', '--proposal', proposal.id, '--reviewer', 'human');
        const promoted = run('promote', '--approval', approval.id, '--reviewer', 'human');
        expect(run('export').revision).toBe(promoted.id);
        expect(run('history')).toMatchObject({ total: 2 });
        const reverted = run('revert', '--revision', promoted.id, '--reviewer', 'human');
        expect(run('export', '--revision', reverted.id).changes[0].after).toBe('Old description');
        const disposable = run('fork', '--actor', 'agent');
        expect(run('discard', '--run', disposable.id).status).toBe('discarded');
    });

    it('keeps errors on stderr, validates flags and refuses executable/typed payloads', async () => {
        const help = spawnSync(process.execPath, [cli, 'workspace', '--help'], { encoding: 'utf8' }); expect(help.status).toBe(0); expect(help.stdout).toContain('trusted reviewer');
        const workspace = await f.create(); await workspace.close();
        for (const args of [
            ['unknown'], ['describe', '--actor', 'unexpected'], ['query'], ['fork'],
            ['history', '--offset', '-1'], ['history', '--limit', '0'], ['export', '--revision', 'unknown'],
        ]) {
            const response = spawnSync(process.execPath, [cli, 'workspace', args[0]!, f.filepath, ...args.slice(1)], { encoding: 'utf8' });
            expect(response.status).not.toBe(0); expect(response.stdout).toBe(''); expect(JSON.parse(response.stderr)).toMatchObject({ ok: false });
        }
        const payload = join(f.directory, 'typed.json'); const rules = join(f.directory, 'rules.json');
        await writeFile(payload, JSON.stringify({ products: [{ id: 'x', description: 1 }] })); await writeFile(rules, JSON.stringify(policy));
        const typed = spawnSync(process.execPath, [cli, 'workspace', 'init', join(f.directory, 'bad'), '--snapshot', payload, '--policy', rules, '--source-revision', 'x', '--actor', 'host'], { encoding: 'utf8' });
        expect(typed.status).toBe(2); expect(JSON.parse(typed.stderr).error.code).toBe('STRINGBASE_INVALID_DATA');
    });
});
