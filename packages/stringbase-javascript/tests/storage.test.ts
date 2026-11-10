import { describe, expect, it, vi } from 'vitest';
import { chmod, link, readFile, readdir, stat, symlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import Stringbase from '../source';
import { fileIO } from '../source/storage/file';
import { fixture } from './helpers';

describe('file storage', () => {
    const f = fixture();
    it('allows a read-only snapshot alongside a writer and reloads whole commits', async () => {
        const writer = await f.create();
        const reader = await f.open('readonly');
        await expect(reader.collection('records').insertOne({ id: 'x' })).rejects.toMatchObject({ code: 'STRINGBASE_READ_ONLY' });
        await writer.collection('records').insertOne({ id: 'new' });
        expect(await reader.collection('records').count()).toBe(0);
        await reader.reload();
        expect(await reader.collection('records').get('new')).toEqual({ id: 'new' });
        expect((await stat(f.filepath)).mode & 0o777).toBe(0o600);
        await chmod(f.filepath, 0o640);
        await writer.collection('records').updateOne('new', { touched: 'yes' });
        expect((await stat(f.filepath)).mode & 0o777).toBe(0o640);
    });

    it('coordinates independent processes and module formats, releasing ownership on close', async () => {
        const writer = await f.create();
        await expect(Stringbase.open({ filepath: f.filepath })).rejects.toMatchObject({ code: 'STRINGBASE_LOCKED' });
        const module = new URL('../distribution/index.cjs', import.meta.url).pathname;
        const childFile = join(f.directory, 'contender.cjs');
        await writeFile(childFile, `const {Stringbase}=require(${JSON.stringify(module)}); Stringbase.open({filepath:process.argv[2]}).then(async db=>{await db.close();process.send('opened')}, e=>process.send(e.code));`);
        const contender = async () => {
            const child = fork(childFile, [f.filepath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
            const exit = once(child, 'exit');
            const [message] = await once(child, 'message');
            await exit;
            return message as string;
        };
        expect(await contender()).toBe('STRINGBASE_LOCKED');
        await writer.close();
        expect(await contender()).toBe('opened');
    });

    it('refuses symlink and hard-link aliases without modifying their targets', async () => {
        const db = await f.create(); await db.close();
        const alias = join(f.directory, 'alias.deon');
        await symlink(f.filepath, alias);
        await expect(Stringbase.open({ filepath: alias })).rejects.toBeInstanceOf(Error);
        await rm(alias); await link(f.filepath, alias);
        await expect(Stringbase.open({ filepath: alias })).rejects.toMatchObject({ code: 'STRINGBASE_INVALID_OPTIONS' });
        await rm(alias);
        const reopened = await f.open();
        expect(await reopened.listCollections()).toEqual(['records']);
    });

    it('keeps an already-open reader valid when a writer replaces its inode', async () => {
        const writer = await f.create();
        let opened!: () => void;
        let release!: () => void;
        const ready = new Promise<void>(resolve => { opened = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const open = fileIO.open;
        let intercept = true;
        vi.spyOn(fileIO, 'open').mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (intercept && args[0] === f.filepath) { intercept = false; opened(); await gate; }
            return handle;
        });
        const pending = Stringbase.open({ filepath: f.filepath, mode: 'readonly' });
        try { await ready; await writer.collection('records').insertOne({ id: 'new' }); }
        finally { release(); }
        const reader = f.track(await pending);
        expect(await reader.collection('records').count()).toBe(0);
        await reader.reload();
        expect(await reader.collection('records').count()).toBe(1);
    });

    it('detects external edits and retains readable state after a bad reload', async () => {
        const db = await f.create();
        await db.collection('records').insertOne({ id: '1', value: 'old' });
        await writeFile(f.filepath, '{ records [');
        await expect(db.reload()).rejects.toMatchObject({ code: 'STRINGBASE_FILE_FORMAT' });
        expect((await db.collection('records').get('1'))?.value).toBe('old');
        await expect(db.collection('records').updateOne('1', { value: 'new' })).rejects.toMatchObject({ code: 'STRINGBASE_CONFLICT' });
        expect(await readFile(f.filepath, 'utf8')).toBe('{ records [');
        await writeFile(f.filepath, '{ records [{ id 2, value edited }] }\n');
        await db.reload();
        await db.collection('records').updateOne('2', { value: 'new' });
        expect((await db.collection('records').get('2'))?.value).toBe('new');
    });

    it.each([
        Buffer.from([0xff]), Buffer.from('{ broken'), Buffer.from('{ records {} }'),
        Buffer.from('{ records [{ name missing-id }] }'),
        Buffer.from('import external from other\n{ records #external }'),
        Buffer.from('{ records [{ id 1, value #$HOME }] }'),
        Buffer.from('{ records [{ id 1, value `prefix #{$HOME}` }] }'),
    ])('refuses invalid input without resetting or rewriting it %#', async bytes => {
        await writeFile(f.filepath, bytes);
        await expect(Stringbase.open({ filepath: f.filepath })).rejects.toMatchObject({ code: 'STRINGBASE_FILE_FORMAT' });
        expect(await readFile(f.filepath)).toEqual(bytes);
        expect(await readdir(f.directory)).toEqual(['data.deon']);
    });

    it('enforces input/output byte limits and releases ownership after failed open', async () => {
        const db = await Stringbase.create({ filepath: f.filepath, maxFileBytes: 128 }); f.track(db);
        await db.createCollection('records');
        await expect(db.collection('records').insertOne({ id: '1', text: 'x'.repeat(256) })).rejects.toMatchObject({ code: 'STRINGBASE_LIMIT_EXCEEDED' });
        expect(await db.collection('records').count()).toBe(0);
        await db.close();
        await expect(Stringbase.open({ filepath: f.filepath, maxFileBytes: 1 })).rejects.toMatchObject({ code: 'STRINGBASE_LIMIT_EXCEEDED' });
        expect(await readdir(f.directory)).toEqual(['data.deon']);
    });

    it('leaves old bytes and memory after a known rename failure, then continues', async () => {
        const db = await f.create();
        await db.collection('records').insertOne({ id: '1', value: 'old' });
        const before = await readFile(f.filepath);
        vi.spyOn(fileIO, 'rename').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
        await expect(db.collection('records').updateOne('1', { value: 'failed' })).rejects.toMatchObject({ code: 'STRINGBASE_IO' });
        expect(await readFile(f.filepath)).toEqual(before);
        expect((await db.collection('records').get('1'))?.value).toBe('old');
        expect((await readdir(f.directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
        await db.collection('records').updateOne('1', { value: 'good' });
        expect((await db.collection('records').get('1'))?.value).toBe('good');
    });

    it('stops reads and queued work after an uncertain replacement and recovers by reopen', async () => {
        const db = await f.create();
        await db.collection('records').insertOne({ id: '1', value: 'old' });
        const rename = fileIO.rename;
        vi.spyOn(fileIO, 'rename').mockImplementationOnce(async (...args) => { await rename(...args); throw new Error('lost acknowledgment'); });
        const mutation = db.collection('records').updateOne('1', { value: 'committed' });
        const queued = db.listCollections();
        await expect(mutation).rejects.toMatchObject({ code: 'STRINGBASE_COMMIT_UNCERTAIN' });
        await expect(queued).rejects.toMatchObject({ code: 'STRINGBASE_COMMIT_UNCERTAIN' });
        await expect(db.collection('records').get('1')).rejects.toMatchObject({ code: 'STRINGBASE_COMMIT_UNCERTAIN' });
        await db.close();
        const reopened = await f.open();
        expect((await reopened.collection('records').get('1'))?.value).toBe('committed');
    });

    it('treats directory synchronization failure after replacement as uncertain', async () => {
        const db = await f.create();
        const open = fileIO.open;
        vi.spyOn(fileIO, 'open').mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (args[0] === f.directory && args[1] === 'r') vi.spyOn(handle, 'sync').mockRejectedValueOnce(Object.assign(new Error('sync failed'), { code: 'EIO' }));
            return handle;
        });
        await expect(db.collection('records').insertOne({ id: '1' })).rejects.toMatchObject({ code: 'STRINGBASE_COMMIT_UNCERTAIN' });
        await db.close(); vi.restoreAllMocks();
        expect(await (await f.open()).collection('records').get('1')).toEqual({ id: '1' });
    });

    it('publishes a new file exclusively even when another file appears at publication', async () => {
        const link = fileIO.link;
        vi.spyOn(fileIO, 'link').mockImplementationOnce(async (...args) => {
            await writeFile(f.filepath, '{ external [] }\n');
            return link(...args);
        });
        await expect(Stringbase.create({ filepath: f.filepath })).rejects.toMatchObject({ code: 'STRINGBASE_FILE_EXISTS' });
        expect(await readFile(f.filepath, 'utf8')).toBe('{ external [] }\n');
    });

    it('reports close cleanup failures and allows cleanup to be retried', async () => {
        const db = await f.create();
        vi.spyOn(fileIO, 'rm').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
        await expect(db.close()).rejects.toMatchObject({ code: 'STRINGBASE_IO' });
        await db.close();
        expect(await readdir(f.directory)).toEqual(['data.deon']);
    });

    it('cleans a partially written temporary file without changing committed state', async () => {
        const db = await f.create();
        const before = await readFile(f.filepath);
        const open = fileIO.open;
        vi.spyOn(fileIO, 'open').mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (String(args[0]).endsWith('.tmp')) {
                const write = handle.writeFile.bind(handle);
                vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
                    await write('partial');
                    throw Object.assign(new Error('full'), { code: 'ENOSPC' });
                });
            }
            return handle;
        });
        await expect(db.collection('records').insertOne({ id: '1' })).rejects.toMatchObject({ code: 'STRINGBASE_IO' });
        expect(await readFile(f.filepath)).toEqual(before);
        expect(await db.collection('records').count()).toBe(0);
        expect((await readdir(f.directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    });

    it.each(['before', 'after'])('survives SIGKILL %s atomic replacement with a valid old or new database', async phase => {
        const db = await f.create();
        await db.collection('records').insertOne({ id: 'old' });
        await db.close();
        const module = new URL('../distribution/index.cjs', import.meta.url).pathname;
        const childFile = join(f.directory, 'interrupted.cjs');
        await writeFile(childFile, `
const fs = require('node:fs/promises');
const rename = fs.rename;
const phase = process.argv[3];
process.on('message', () => {});
fs.rename = async (...args) => {
  if (phase === 'after') await rename(...args);
  process.send(phase);
  await new Promise(() => {});
};
const { Stringbase } = require(${JSON.stringify(module)});
Stringbase.open({ filepath: process.argv[2] }).then(async db => {
  await db.collection('records').insertOne({ id: 'new' });
}).catch(error => { process.send({ error: error.message }); process.exitCode = 1; });
`);
        const child = fork(childFile, [f.filepath, phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        const exit = once(child, 'exit');
        try {
            const [checkpoint] = await once(child, 'message');
            expect(checkpoint).toBe(phase);
            child.kill('SIGKILL');
            await exit;
            const reader = await f.open('readonly');
            expect((await reader.collection('records').find()).map(doc => doc.id)).toEqual(phase === 'before' ? ['old'] : ['old', 'new']);
            await expect(Stringbase.open({ filepath: f.filepath })).rejects.toMatchObject({ code: 'STRINGBASE_LOCKED' });
            // Explicit recovery after confirmed owner death; the SDK never steals a lock.
            await rm(`${f.filepath}.stringbase-lock`, { recursive: true });
            const reopened = await f.open();
            await reopened.collection('records').insertOne({ id: 'recovered' });
            expect(await reopened.collection('records').get('recovered')).toEqual({ id: 'recovered' });
        } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } }
    });
});
