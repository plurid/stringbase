import { describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { query, field, literal, eq, gte } from '@plurid/loque';
import Stringbase, { applyBatch, type Fields, type Transaction, type QueryInput } from '../source';
import { fileIO } from '../source/storage/file';
import { fixture } from './helpers';

describe('database contract', () => {
    const f = fixture();
    it('persists CRUD and preserves ID, order, strings, and special maps on reopen', async () => {
        let db = await f.create();
        const records = db.collection('records');
        const nested = JSON.parse('{"__proto__":"own", "constructor":"constructor", "kind":"link", "name":"value"}') as Fields;
        const input = { id: '007', value: 'true', nested, text: '\nHello 😀\n', literal: '#{secret}', blank: '' };
        await records.insertMany([input, { id: '2', value: 'false' }]);
        expect(Object.isFrozen(await records.get('007'))).toBe(true);
        input.value = 'changed outside';
        expect((await records.get('007'))?.value).toBe('true');
        expect(await records.updateOne('007', { value: 'true' })).toMatchObject({ matchedCount: 1, modifiedCount: 0 });
        expect(await records.updateOne('007', { value: 'new' })).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
        await db.close();
        db = await f.open();
        expect((await db.collection('records').get('007'))?.nested).toEqual(nested);
        expect((await db.collection('records').get('007'))?.text).toBe(input.text);
        await db.collection('records').updateOne('007', { escapes: '\\u{0}deon-interpolation\\u{0}', marker: '\u0000deon-interpolation\u0000', mixed: '#{literal}\u0000' });
        expect((await db.collection('records').get('007'))?.mixed).toBe('#{literal}\u0000');
        expect((await db.collection('records').get('007'))?.marker).toBe('\u0000deon-interpolation\u0000');
        expect(await db.collection('records').replaceOne('007', { value: 'replacement' })).toMatchObject({ modifiedCount: 1 });
        expect(await db.collection('records').find()).toEqual([{ id: '007', value: 'replacement' }, { id: '2', value: 'false' }]);
        expect(await db.collection('records').deleteOne('007')).toEqual({ deletedCount: 1, ids: ['007'] });
        await db.close();
        db = await f.open();
        expect(await db.collection('records').get('007')).toBeUndefined();
        expect(await db.collection('records').count()).toBe(1);
        expect(await db.collection('records').deleteOne('absent')).toEqual({ deletedCount: 0, ids: [] });
        expect(await db.collection('records').updateOne('absent', { x: 'y' })).toMatchObject({ matchedCount: 0, modifiedCount: 0 });
    });

    it('generates immutable IDs and validates insertMany as a single unit', async () => {
        const db = await f.create();
        const records = db.collection('records');
        const first = await records.insertOne({ value: 'one' });
        expect(first.id).toMatch(/^[\da-f-]{36}$/);
        await expect(records.insertMany([{ id: '2' }, { id: first.id }])).rejects.toMatchObject({ code: 'STRINGBASE_DUPLICATE_ID' });
        expect(await records.count()).toBe(1);
        await expect(records.insertMany([{ id: 'x' }, { id: 'x' }])).rejects.toMatchObject({ code: 'STRINGBASE_DUPLICATE_ID' });
        await expect(records.updateOne(first.id, { id: 'other' })).rejects.toMatchObject({ code: 'STRINGBASE_INVALID_DATA' });
        await expect(records.replaceOne(first.id, { id: first.id })).rejects.toMatchObject({ code: 'STRINGBASE_INVALID_DATA' });
        await expect(records.insertOne({ id: '' })).rejects.toMatchObject({ code: 'STRINGBASE_INVALID_DATA' });
    });

    it('uses Loque selections for typed bulk updates without persisting converted values', async () => {
        const db = await f.create();
        const records = db.collection('records');
        await records.insertMany([{ id: '001', age: '12', active: 'true' }, { id: '2', age: '3', active: 'false' }]);
        const q = query().where(gte(field('age'), literal(10))).sort(field('age'), 'desc');
        expect(await records.find(q)).toEqual([]);
        expect((await records.find(q, { view: 'typed' })).map(doc => doc.id)).toEqual(['001']);
        expect(await records.updateMany(q, { touched: 'yes' }, { view: 'typed' })).toEqual({ matchedCount: 1, modifiedCount: 1, ids: ['001'] });
        expect(await records.get('001')).toEqual({ id: '001', age: '12', active: 'true', touched: 'yes' });
        await records.deleteMany(query().where(eq(field('active'), literal(false))), { view: 'typed' });
        expect(await records.count()).toBe(1);
        await expect(records.deleteMany(undefined as unknown as QueryInput)).rejects.toMatchObject({ code: 'STRINGBASE_INVALID_QUERY' });
    });

    it('commits a cross-collection batch once and rolls back caught operation failures', async () => {
        const db = await f.create();
        await db.createCollection('events');
        await db.collection('records').insertOne({ id: '1', active: 'true' });
        const rename = vi.spyOn(fileIO, 'rename');
        let captured: Transaction | undefined;
        await db.batch(tx => {
            captured = tx;
            tx.collection('records').updateOne('1', { active: 'false' });
            expect(tx.collection('records').get('1')?.active).toBe('false');
            tx.collection('events').insertOne({ recordId: '1' });
        });
        expect(rename).toHaveBeenCalledTimes(1);
        expect(() => captured!.listCollections()).toThrow(/expired/);
        const bytes = await readFile(f.filepath, 'utf8');
        await expect(db.batch(tx => {
            tx.collection('records').updateOne('1', { active: 'changed' });
            try { tx.collection('events').insertOne({ id: '' }); } catch { /* Caller cannot un-fail the batch. */ }
        })).rejects.toMatchObject({ code: 'STRINGBASE_BATCH_FAILED' });
        expect(await readFile(f.filepath, 'utf8')).toBe(bytes);
        await expect(db.batch(() => { throw new Error('abort'); })).rejects.toThrow('abort');
    });

    it('rejects asynchronous and reentrant batch usage and leaves the database usable', async () => {
        const db = await f.create();
        const asynchronous = (async (tx: Transaction) => { tx.collection('records').insertOne({ id: '1' }); }) as unknown as (tx: Transaction) => never;
        await expect(db.batch(asynchronous)).rejects.toMatchObject({ code: 'STRINGBASE_BATCH_FAILED' });
        await expect(db.batch(() => { void db.listCollections().catch(() => undefined); })).rejects.toMatchObject({ code: 'STRINGBASE_BATCH_FAILED' });
        await expect(db.batch(() => { void db.close().catch(() => undefined); })).rejects.toMatchObject({ code: 'STRINGBASE_BATCH_FAILED' });
        expect(await db.collection('records').count()).toBe(0);
        await db.collection('records').insertOne({ id: 'good' });
        expect(await db.collection('records').count()).toBe(1);
    });

    it('drains admitted work on close and rejects later work', async () => {
        const db = await f.create();
        const pending = Array.from({ length: 10 }, (_, i) => db.collection('records').insertOne({ id: String(i) }));
        const close = db.close();
        await expect(db.listCollections()).rejects.toMatchObject({ code: 'STRINGBASE_CLOSED' });
        await Promise.all(pending); await close; await db.close();
        const reopened = await f.open();
        expect((await reopened.collection('records').find()).map(doc => doc.id)).toEqual(pending.map((_, i) => String(i)));
    });

    it('preserves authored bytes on open and no-op writes, normalizes only real mutations', async () => {
        await writeFile(f.filepath, '// authored\n{ records [ #one ] }\none { id 1, value old }\n');
        const before = await readFile(f.filepath, 'utf8');
        const db = await f.open();
        await db.collection('records').updateOne('1', { value: 'old' });
        await db.collection('records').insertMany([]);
        await db.batch(() => undefined);
        expect(await readFile(f.filepath, 'utf8')).toBe(before);
        await db.collection('records').updateOne('1', { value: 'new' });
        expect(await readFile(f.filepath, 'utf8')).not.toContain('// authored');
        expect(await db.collection('records').get('1')).toEqual({ id: '1', value: 'new' });
    });

    it('does not create collections implicitly and validates lifecycle options', async () => {
        await expect(Stringbase.open({ filepath: f.filepath })).rejects.toMatchObject({ code: 'STRINGBASE_FILE_NOT_FOUND' });
        await expect(Stringbase.create({ filepath: f.filepath, maxFileBytes: 0 })).rejects.toMatchObject({ code: 'STRINGBASE_INVALID_OPTIONS' });
        const db = await f.create();
        await expect(db.collection('missing').find()).rejects.toMatchObject({ code: 'STRINGBASE_COLLECTION_NOT_FOUND' });
        await expect(db.createCollection('records')).rejects.toMatchObject({ code: 'STRINGBASE_COLLECTION_EXISTS' });
        await db.createCollection('alpha');
        expect(await db.listCollections()).toEqual(['alpha', 'records']);
        await db.dropCollection('alpha');
        await db.close();
        await expect(Stringbase.create({ filepath: f.filepath })).rejects.toMatchObject({ code: 'STRINGBASE_FILE_EXISTS' });
    });

    it('validates declarative batch payloads before publishing any operation', async () => {
        const db = await f.create();
        await applyBatch(db, { version: 1, operations: [
            { op: 'insertOne', collection: 'records', document: { id: '1' } },
            { op: 'updateOne', collection: 'records', id: '1', fields: { value: 'new' } },
        ] });
        expect(await db.collection('records').get('1')).toEqual({ id: '1', value: 'new' });
        await expect(applyBatch(db, { version: 1, operations: [{ op: 'dropCollection', collection: 'records', hidden: 'x' }] })).rejects.toMatchObject({ code: 'STRINGBASE_INVALID_DATA' });
        await expect(applyBatch(db, { version: 1, operations: [
            { op: 'insertOne', collection: 'records', document: { id: '2' } },
            { op: 'insertOne', collection: 'records', document: { id: '1' } },
        ] })).rejects.toMatchObject({ code: 'STRINGBASE_DUPLICATE_ID' });
        expect(await db.collection('records').count()).toBe(1);
    });
});
