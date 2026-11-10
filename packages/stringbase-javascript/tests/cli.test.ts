import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers';

const execute = promisify(execFile);
const cli = new URL('../distribution/cli.mjs', import.meta.url).pathname;
async function run(...args: string[]) {
    try { const result = await execute(process.execPath, [cli, ...args]); return { ...result, code: 0 }; }
    catch (error) {
        const result = error as { stdout: string; stderr: string; code: number };
        return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    }
}

describe('installed CLI behavior', () => {
    const f = fixture();
    it('supports the complete read/write flow with JSON stdout', async () => {
        expect((await run('init', f.filepath)).code).toBe(0);
        expect((await run('create-collection', f.filepath, 'records')).code).toBe(0);
        const payload = join(f.directory, 'record.deon');
        await writeFile(payload, '{ id 007, name Ada, age 37 }');
        const inserted = await run('insert', f.filepath, 'records', '--data-file', payload);
        expect(inserted.code).toBe(0); expect(inserted.stderr).toBe('');
        expect(JSON.parse(inserted.stdout)).toEqual({ id: '007', name: 'Ada', age: '37' });
        expect(JSON.parse((await run('query', f.filepath, 'records.age>=18', '--view', 'typed')).stdout)).toHaveLength(1);
        await writeFile(payload, '{ name Updated }');
        expect((await run('update', f.filepath, 'records', '007', '--data-file', payload)).code).toBe(0);
        expect(JSON.parse((await run('get', f.filepath, 'records', '007')).stdout).name).toBe('Updated');
        expect(JSON.parse((await run('validate', f.filepath)).stdout)).toEqual({ valid: true, collections: 1, documents: 1 });
        expect((await run('delete', f.filepath, 'records', '007')).code).toBe(0);
        expect((await run('get', f.filepath, 'records', '007')).code).toBe(3);
        expect(JSON.parse((await run('collections', f.filepath)).stdout)).toEqual(['records']);
    });
    it('rejects invalid options and requires an explicit all selector for bulk writes', async () => {
        const db = await f.create(); await db.close();
        const before = await readFile(f.filepath, 'utf8');
        const ambiguous = await run('delete-many', f.filepath, 'records');
        expect(ambiguous.code).toBe(2); expect(ambiguous.stdout).toBe('');
        expect((await run('query', f.filepath, 'records', '--limit', '-1')).code).toBe(2);
        expect((await run('delete-many', f.filepath, 'records', '--all')).code).toBe(0);
        expect(await readFile(f.filepath, 'utf8')).toBe(before);
        expect((await run('--unknown')).code).toBe(2);
        expect((await run('--version')).stdout.trim()).toBe('0.0.0-1');
    });
    it('applies a declarative cross-collection batch without executing source code', async () => {
        const db = await f.create(); await db.close();
        const operations = join(f.directory, 'batch.json');
        await writeFile(operations, JSON.stringify({ version: 1, operations: [
            { op: 'createCollection', collection: 'events' },
            { op: 'insertOne', collection: 'records', document: { id: '1' } },
            { op: 'insertOne', collection: 'events', document: { id: 'event', recordId: '1' } },
        ] }));
        expect((await run('batch', f.filepath, '--operations', operations)).code).toBe(0);
        expect(JSON.parse((await run('validate', f.filepath)).stdout)).toEqual({ valid: true, collections: 2, documents: 2 });
    });
});
