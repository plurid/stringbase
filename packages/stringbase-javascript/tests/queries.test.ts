import { describe, expect, it } from 'vitest';
import { query, field, literal, eq, not, exists, probability } from '@plurid/loque';
import { fixture } from './helpers';
import { parseLocator, type Fields } from '../source';
import { copyValue, databaseData } from '../source/model';

describe('queries and locators', () => {
    const f = fixture();
    it('compiles locators to the same predicates as structured Loque queries', async () => {
        const db = await f.create();
        await db.collection('records').insertMany([
            { id: '007', name: 'Ada Lovelace', active: 'true', age: '37', profile: { city: 'London' }, items: [{ 'a.b': 'yes' }] },
            { id: '2', name: 'Grace', active: 'false', age: '12' },
            { id: '3', active: 'pending', age: '3', profile: { city: 'London' } },
        ]);
        const records = db.collection('records');
        expect(await db.read('records.id:007')).toEqual(await records.find(query().where(eq(field('id'), literal('007')))));
        expect((await db.read("records.(active:true | active:pending) & {profile.city}:London")).map(doc => doc.id)).toEqual(['007', '3']);
        expect((await db.read("records.name:'Ada Lovelace'")).map(doc => doc.id)).toEqual(['007']);
        expect((await db.read("records.{items[0]['a.b']}:yes")).map(doc => doc.id)).toEqual(['007']);
        expect((await db.read('records.age>=18', { view: 'typed', sort: { path: ['age'], direction: 'desc' }, limit: 1 })).map(doc => doc.id)).toEqual(['007']);
        expect((await db.read('records.age>=18')).map(doc => doc.id)).toEqual(['007', '3']);
        expect((await db.read('records.id:007', { view: 'typed' })).map(doc => doc.id)).toEqual(['007']);
        expect((await records.find(query().where(not(exists(field('name')))))).map(doc => doc.id)).toEqual(['3']);
        expect((await db.read('records', { skip: 1, limit: 1 })).map(doc => doc.id)).toEqual(['2']);
        await expect(records.find(query().each())).rejects.toMatchObject({ code: 'STRINGBASE_INVALID_QUERY' });
    });

    it('quotes literal operator characters, empty strings, Unicode, and numeric decimals', () => {
        expect(parseLocator("records.name:'A & B | C\\n😀'").query.steps).toHaveLength(1);
        expect(parseLocator("records.name:''").query.steps).toHaveLength(1);
        expect(parseLocator('records.age>=1.50', { view: 'typed' }).query.steps[0]).toMatchObject({ predicate: { right: { value: 1.5 } } });
        expect(parseLocator("records.name:'\\u{1f600}'").query.steps[0]).toMatchObject({ predicate: { right: { value: '😀' } } });
        expect(parseLocator('records\n . active : true').collection).toBe('records');
    });

    it.each(['', 'records.', 'records.x:', 'records.x:one trailing', 'records.x==one', "records.name:'unterminated", 'records.x:1 |first 5|', 'records.{a[bad]}:x', 'records.(x:1', "records.x:'\\u{d800}'", "records.x:'\\u{ffffff}'"])('refuses malformed locator %s', source => {
        expect(() => parseLocator(source)).toThrow();
        try { parseLocator(source); } catch (error) { expect(error).toMatchObject({ code: 'STRINGBASE_INVALID_LOCATOR', details: { line: expect.any(Number), column: expect.any(Number) } }); }
    });

    it('bounds source size, groups, and caller supplied IR', async () => {
        expect(() => parseLocator(`records.x:'${'x'.repeat(17000)}'`)).toThrow(/16 KiB/);
        expect(() => parseLocator(`records.${'('.repeat(33)}x:1${')'.repeat(33)}`)).toThrow(/32/);
        const db = await f.create();
        const steps = Array.from({ length: 257 }, () => ({ op: 'limit' as const, count: 1 }));
        await expect(db.collection('records').find({ version: 1, steps })).rejects.toMatchObject({ code: 'STRINGBASE_LIMIT_EXCEEDED' });
    });
    it('treats operator-shaped maps as literal data, not executable judgments', async () => {
        const db = await f.create();
        await db.collection('records').insertOne({ id: '1', value: { op: 'probability' } });
        const rows = await db.collection('records').find(query().where(eq(field('value'), literal({ op: 'probability' }))));
        expect(rows.map(doc => doc.id)).toEqual(['1']);
        await expect(db.collection('records').find(query().where(eq(probability('fraud', true), literal(0.5)))))
            .rejects.toMatchObject({ code: 'STRINGBASE_INVALID_QUERY' });
        await expect(db.collection('records').insertMany(Array<Fields>(2))).rejects.toMatchObject({ code: 'STRINGBASE_INVALID_DATA' });
    });
});

describe('data boundary', () => {
    it.each([null, undefined, true, 3, new Date(), Array<string>(2), '\ud800', { id: 'x', value: undefined }])('refuses non-Deon data %#', value => {
        expect(() => copyValue(value)).toThrow();
    });
    it('rejects cycles and accessors without invoking them', () => {
        let called = false;
        const accessor = { get secret() { called = true; return 'secret'; } };
        expect(() => copyValue(accessor)).toThrow();
        expect(called).toBe(false);
        const cycle: unknown[] = []; cycle.push(cycle);
        expect(() => copyValue(cycle)).toThrow(/Cyclic/);
        expect(() => databaseData({ records: [{ id: '1' }, { id: '1' }] })).toThrow(/Duplicate/);
        const deep: Fields = { leaf: 'x' };
        let value: unknown = deep;
        for (let i = 0; i < 129; i++) value = [value];
        expect(() => copyValue(value)).toThrow(/128/);
    });
});
