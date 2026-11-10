import { AsyncLocalStorage } from 'node:async_hooks';
import { query, field, isIn, snapshot } from '@plurid/loque';
import type { Mutation, QueryIR } from '@plurid/loque';
import { fail, StringbaseError } from './errors';
import { collectionName, copyValue, databaseData, documentId, fields, insertion, requireCollection, same, updateFields } from './model';
import { select } from './queries';
import { parseLocator } from './locator';
import { FileStore } from './storage/file';
import type { DatabaseData, DeleteResult, Document, Fields, QueryInput, QueryOptions, ReadOptions, StringbaseOptions, UpdateResult } from './types';

const CHANGE = Symbol('stringbase.change');
const READ = Symbol('stringbase.read');
const context = new AsyncLocalStorage<{ database: Stringbase; transaction: Stage }>();

export interface Transaction {
    collection(name: string): TransactionCollection;
    listCollections(): readonly string[];
    createCollection(name: string): void;
    dropCollection(name: string): void;
}

class Stage {
    private active = true;
    private failure: unknown;
    private failed = false;
    constructor(private data: DatabaseData) {}
    run<T>(operation: () => T): T {
        if (!this.active) fail('CLOSED', 'Transaction scope has expired.');
        if (this.failed) throw new StringbaseError('BATCH_FAILED', 'The transaction already failed.', {}, this.failure);
        try { return operation(); } catch (cause) { this.failed = true; this.failure = cause; throw cause; }
    }
    abort(cause: unknown): void { this.failed = true; this.failure ??= cause; }
    finish(): DatabaseData {
        this.active = false;
        if (this.failed) throw new StringbaseError('BATCH_FAILED', 'A transaction operation failed.', {}, this.failure);
        return this.data;
    }
    expire(): void { this.active = false; }
    collection(name: string): TransactionCollection { return this.run(() => { collectionName(name); return new TransactionCollection(this, name); }); }
    listCollections(): readonly string[] { return this.run(() => Object.freeze(Object.keys(this.data).sort())); }
    createCollection(name: string): void {
        this.run(() => {
            collectionName(name);
            if (Object.hasOwn(this.data, name)) fail('COLLECTION_EXISTS', `Collection '${name}' already exists.`);
            this.data = databaseData(snapshot(this.data).select(query()).plan({ op: 'merge', value: { [name]: [] } }).apply().value);
        });
    }
    dropCollection(name: string): void {
        this.run(() => {
            requireCollection(this.data, name);
            this.data = databaseData(snapshot(this.data).select(query().field(name)).plan({ op: 'remove' }).apply().value);
        });
    }
    find(name: string, input?: QueryInput, options?: QueryOptions): readonly Document[] {
        return this.run(() => select(this.data, name, input, options));
    }
    private mutate(name: string, ids: readonly string[], mutation: Mutation): void {
        const targets = query().field(name).each().where(isIn(field('id'), ids));
        this.data = databaseData(snapshot(this.data).select(targets).plan(mutation).apply().value);
    }
    insert(name: string, inputs: readonly Fields[]): readonly Document[] {
        return this.run(() => {
            const records = requireCollection(this.data, name);
            if (!Array.isArray(inputs)) fail('INVALID_DATA', 'insertMany expects a document list.');
            const inserted = (copyValue(inputs) as readonly Fields[]).map(insertion);
            if (inserted.length) this.data = databaseData(snapshot(this.data).select(query().field(name))
                .plan({ op: 'replace', value: [...records, ...inserted] }).apply().value);
            return Object.freeze(inserted);
        });
    }
    update(name: string, input: QueryInput, patch: Fields, options?: QueryOptions, replacement = false): UpdateResult {
        return this.run(() => {
            if (input === undefined) fail('INVALID_QUERY', 'Bulk mutations require an explicit query.');
            const value = updateFields(patch);
            const matches = select(this.data, name, input, options);
            const changed = matches.filter(doc => !same(doc, fields({ ...(!replacement ? doc : {}), ...value, id: doc.id })));
            if (replacement) {
                for (const doc of changed) this.mutate(name, [doc.id], { op: 'replace', value: { ...value, id: doc.id } });
            } else if (changed.length) this.mutate(name, changed.map(doc => doc.id), { op: 'merge', value });
            return Object.freeze({ matchedCount: matches.length, modifiedCount: changed.length, ids: Object.freeze(matches.map(doc => doc.id)) });
        });
    }
    remove(name: string, input: QueryInput, options?: QueryOptions): DeleteResult {
        return this.run(() => {
            if (input === undefined) fail('INVALID_QUERY', 'Bulk mutations require an explicit query.');
            const matches = select(this.data, name, input, options);
            const ids = Object.freeze(matches.map(doc => doc.id));
            if (ids.length) this.mutate(name, ids, { op: 'remove' });
            return Object.freeze({ deletedCount: ids.length, ids });
        });
    }
}

function byId(id: string): QueryInput { documentId(id); return query().where(isIn(field('id'), [id])); }

export class TransactionCollection {
    constructor(private readonly tx: Stage, readonly name: string) {}
    find(input?: QueryInput, options?: QueryOptions): readonly Document[] { return this.tx.find(this.name, input, options); }
    get(id: string): Document | undefined { return this.tx.run(() => this.find(byId(id))[0]); }
    count(input?: QueryInput, options?: QueryOptions): number { return this.find(input, options).length; }
    insertOne(document: Fields): Document { return this.tx.insert(this.name, [document])[0]!; }
    insertMany(documents: readonly Fields[]): readonly Document[] { return this.tx.insert(this.name, documents); }
    updateOne(id: string, patch: Fields): UpdateResult { return this.tx.run(() => this.tx.update(this.name, byId(id), patch)); }
    replaceOne(id: string, fields: Fields): UpdateResult { return this.tx.run(() => this.tx.update(this.name, byId(id), fields, undefined, true)); }
    updateMany(input: QueryInput, patch: Fields, options?: QueryOptions): UpdateResult { return this.tx.update(this.name, input, patch, options); }
    deleteOne(id: string): DeleteResult { return this.tx.run(() => this.tx.remove(this.name, byId(id))); }
    deleteMany(input: QueryInput, options?: QueryOptions): DeleteResult { return this.tx.remove(this.name, input, options); }
}

export class Collection {
    constructor(private readonly db: Stringbase, readonly name: string) {}
    find(input?: QueryInput, options?: QueryOptions): Promise<readonly Document[]> { return this.db[READ](this.name, input, options); }
    async get(id: string): Promise<Document | undefined> { return (await this.find(byId(id)))[0]; }
    async count(input?: QueryInput, options?: QueryOptions): Promise<number> { return (await this.find(input, options)).length; }
    insertOne(document: Fields): Promise<Document> { return this.db[CHANGE](tx => tx.collection(this.name).insertOne(document)); }
    insertMany(documents: readonly Fields[]): Promise<readonly Document[]> { return this.db[CHANGE](tx => tx.collection(this.name).insertMany(documents)); }
    updateOne(id: string, patch: Fields): Promise<UpdateResult> { return this.db[CHANGE](tx => tx.collection(this.name).updateOne(id, patch)); }
    replaceOne(id: string, fields: Fields): Promise<UpdateResult> { return this.db[CHANGE](tx => tx.collection(this.name).replaceOne(id, fields)); }
    updateMany(input: QueryInput, patch: Fields, options?: QueryOptions): Promise<UpdateResult> { return this.db[CHANGE](tx => tx.collection(this.name).updateMany(input, patch, options)); }
    deleteOne(id: string): Promise<DeleteResult> { return this.db[CHANGE](tx => tx.collection(this.name).deleteOne(id)); }
    deleteMany(input: QueryInput, options?: QueryOptions): Promise<DeleteResult> { return this.db[CHANGE](tx => tx.collection(this.name).deleteMany(input, options)); }
}

export class Stringbase {
    private state: 'open' | 'closing' | 'closed' = 'open';
    private tail: Promise<void> = Promise.resolve();
    private closing: Promise<void> | undefined;
    private uncertain: unknown;
    private constructor(private readonly store: FileStore, private data: DatabaseData) {}
    static async open(options: StringbaseOptions): Promise<Stringbase> {
        const { store, data } = await FileStore.open(options, false);
        return new Stringbase(store, data);
    }
    static async create(options: StringbaseOptions): Promise<Stringbase> {
        const { store, data } = await FileStore.open(options, true);
        return new Stringbase(store, data);
    }
    get filepath(): string { return this.store.filepath; }
    collection(name: string): Collection { collectionName(name); return new Collection(this, name); }

    private enqueue<T>(operation: () => T | Promise<T>, write = false): Promise<T> {
        const inside = context.getStore();
        if (inside?.database === this) {
            const error = new StringbaseError('BATCH_FAILED', 'Use the transaction facade inside a batch.');
            inside.transaction.abort(error);
            return Promise.reject(error);
        }
        if (this.state !== 'open') return Promise.reject(new StringbaseError('CLOSED', 'Database is closing or closed.'));
        if (this.uncertain) return Promise.reject(this.uncertain);
        if (write && this.store.readonly) return Promise.reject(new StringbaseError('READ_ONLY', 'Database was opened read-only.'));
        const result = this.tail.then(() => {
            if (this.uncertain) throw this.uncertain;
            return operation();
        });
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }

    [READ](name: string, input?: QueryInput, options?: QueryOptions): Promise<readonly Document[]> {
        return this.enqueue(() => select(this.data, name, input, options));
    }
    listCollections(): Promise<readonly string[]> { return this.enqueue(() => Object.freeze(Object.keys(this.data).sort())); }
    createCollection(name: string): Promise<void> { return this[CHANGE](tx => tx.createCollection(name)); }
    dropCollection(name: string): Promise<void> { return this[CHANGE](tx => tx.dropCollection(name)); }

    private async commit(next: DatabaseData): Promise<void> {
        if (same(next, this.data)) return;
        try { await this.store.commit(next); }
        catch (cause) {
            if (cause instanceof StringbaseError && cause.code === 'STRINGBASE_COMMIT_UNCERTAIN') this.uncertain = cause;
            throw cause;
        }
        this.data = next;
    }

    [CHANGE]<T>(callback: (tx: Stage) => T): Promise<T> {
        return this.enqueue(async () => {
            const tx = new Stage(this.data);
            try {
                const result = callback(tx);
                await this.commit(tx.finish());
                return result;
            } finally { tx.expire(); }
        }, true);
    }

    batch<T>(callback: (tx: Transaction) => T extends PromiseLike<unknown> ? never : T): Promise<T> {
        return this.enqueue(async () => {
            if (typeof callback !== 'function') fail('INVALID_OPTIONS', 'batch expects a synchronous callback.');
            const tx = new Stage(this.data);
            try {
                const result = context.run({ database: this, transaction: tx }, () => callback(tx));
                if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
                    void Promise.resolve(result).catch(() => undefined);
                    fail('BATCH_FAILED', 'A batch callback must be synchronous.');
                }
                await this.commit(tx.finish());
                return result as T;
            } finally { tx.expire(); }
        }, true);
    }

    read(locator: string, options: ReadOptions = {}): Promise<readonly Document[]> {
        return this.enqueue(() => {
            if (!options || typeof options !== 'object' || Object.keys(options).some(key => !['view', 'sort', 'skip', 'limit'].includes(key))) fail('INVALID_OPTIONS', 'Invalid locator options.');
            const view: QueryOptions = options.view === undefined ? {} : { view: options.view };
            const parsed = parseLocator(locator, view);
            const steps = [...parsed.query.steps];
            if (options.sort) {
                const { path, direction = 'asc' } = options.sort;
                if (!Array.isArray(path) || !path.length) fail('INVALID_QUERY', 'Sort requires a field path.');
                steps.push({ op: 'sort', by: field(path[0]!, ...path.slice(1)), direction });
            }
            if (options.skip !== undefined) steps.push({ op: 'skip', count: options.skip });
            if (options.limit !== undefined) steps.push({ op: 'limit', count: options.limit });
            return select(this.data, parsed.collection, { version: 1, steps } satisfies QueryIR, view);
        });
    }
    reload(): Promise<void> { return this.enqueue(async () => { this.data = await this.store.reload(); }); }

    close(): Promise<void> {
        const inside = context.getStore();
        if (inside?.database === this) {
            const error = new StringbaseError('BATCH_FAILED', 'A transaction cannot close its database.');
            inside.transaction.abort(error);
            return Promise.reject(error);
        }
        if (this.closing) return this.closing;
        if (this.state === 'closed') return Promise.resolve();
        this.state = 'closing';
        this.closing = this.tail.then(async () => {
            await this.store.close();
            this.state = 'closed';
        }).catch(cause => { this.closing = undefined; throw cause; });
        return this.closing;
    }
}
