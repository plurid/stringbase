import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { typer } from '@plurid/deon/pure';
import type { JsonValue } from '@plurid/loque';
import { fail } from './errors';
import type { DatabaseData, Document, Fields, Value } from './types';

export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const same = isDeepStrictEqual;
export const own = (object: object, key: string): boolean => Object.hasOwn(object, key);
export function define<T>(object: Record<string, T>, key: string, value: T): void {
    Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
}
export function collectionName(name: unknown): asserts name is string {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) fail('INVALID_DATA', 'Invalid collection name.');
}
export function documentId(id: unknown): asserts id is string {
    if (typeof id !== 'string' || id.length === 0) fail('INVALID_DATA', 'A document ID must be a nonempty string.');
}

export function copyValue(input: unknown, depth = 0, ancestors = new Set<object>()): Value {
    if (depth > 128) fail('LIMIT_EXCEEDED', 'Values may nest at most 128 levels.');
    if (typeof input === 'string') {
        if (!input.isWellFormed()) fail('INVALID_DATA', 'Strings must contain valid Unicode scalar values.');
        return input;
    }
    if (input === null || typeof input !== 'object') fail('INVALID_DATA', 'Stored values must be strings, lists, or maps.');
    if (ancestors.has(input)) fail('INVALID_DATA', 'Cyclic data cannot be stored.');
    const array = Array.isArray(input);
    const prototype: unknown = Object.getPrototypeOf(input);
    if (!array && prototype !== null && prototype !== Object.prototype) fail('INVALID_DATA', 'Only plain maps can be stored.');
    ancestors.add(input);
    try {
        const descriptors = Object.getOwnPropertyDescriptors(input);
        const result: Record<string, Value> = Object.create(null) as Record<string, Value>;
        const items: Value[] = [];
        for (const key of Reflect.ownKeys(descriptors)) {
            if (array && key === 'length') continue;
            if (typeof key !== 'string' || !key.isWellFormed()) fail('INVALID_DATA', 'Map keys must be Unicode strings.');
            const descriptor = descriptors[key]!;
            if (!('value' in descriptor) || !descriptor.enumerable) fail('INVALID_DATA', 'Accessors and hidden properties cannot be stored.');
            if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= (input as unknown[]).length)) {
                fail('INVALID_DATA', 'Lists cannot have named properties.');
            }
            const copied = copyValue(descriptor.value, depth + 1, ancestors);
            if (array) items[Number(key)] = copied;
            else define(result, key, copied);
        }
        if (array) {
            if (Object.keys(items).length !== (input as unknown[]).length) fail('INVALID_DATA', 'Sparse lists cannot be stored.');
            return Object.freeze(items);
        }
        return Object.freeze(result);
    } finally { ancestors.delete(input); }
}

export function fields(input: unknown): Fields {
    const result = copyValue(input);
    if (typeof result === 'string' || Array.isArray(result)) fail('INVALID_DATA', 'Expected a document map.');
    return result as Fields;
}

export function databaseData(input: unknown): DatabaseData {
    const root = fields(input);
    for (const [name, entries] of Object.entries(root)) {
        collectionName(name);
        if (!Array.isArray(entries)) fail('INVALID_DATA', `Collection '${name}' must be a list.`);
        const ids = new Set<string>();
        for (const entry of entries as readonly Value[]) {
            if (typeof entry !== 'object' || Array.isArray(entry) || !own(entry, 'id')) fail('INVALID_DATA', `Collection '${name}' must contain documents with IDs.`);
            const id = (entry as Fields).id;
            documentId(id);
            if (ids.has(id)) fail('DUPLICATE_ID', `Duplicate ID '${id}' in '${name}'.`, { collection: name, id });
            ids.add(id);
        }
    }
    return root as DatabaseData;
}

export function insertion(input: unknown): Document {
    const value = fields(input);
    const id = own(value, 'id') ? value.id : randomUUID();
    documentId(id);
    return fields({ ...value, id }) as Document;
}

export function updateFields(input: unknown): Fields {
    const value = fields(input);
    if (own(value, 'id')) fail('INVALID_DATA', 'An update or replacement cannot supply an ID.');
    return value;
}

export function requireCollection(data: DatabaseData, name: string): readonly Document[] {
    collectionName(name);
    if (!own(data, name)) fail('COLLECTION_NOT_FOUND', `Collection '${name}' does not exist.`, { collection: name });
    return data[name]!;
}

/** Type scalars individually: Deon's generic object walker does not retain special own keys. */
export function typedView(value: Value, protectId = false): JsonValue {
    if (typeof value === 'string') return typer<JsonValue>(value);
    if (Array.isArray(value)) return value.map(item => typedView(item));
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, item] of Object.entries(value)) define(result, key, protectId && key === 'id' ? item as string : typedView(item));
    return result;
}
