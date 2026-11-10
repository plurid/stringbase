import { snapshot } from '@plurid/loque';
import { fail, StringbaseError } from './errors';
import { collectionName, documentId, fields, updateFields } from './model';
import { checkedQuery, queryOptions } from './queries';
import type { Stringbase, Transaction } from './database';
import type { BatchOperation, BatchPayload, QueryInput } from './types';

export function validateBatch(input: unknown): BatchPayload {
    let value: unknown;
    try { value = snapshot(input).value; }
    catch (cause) { throw new StringbaseError('INVALID_DATA', 'Batch payload must be JSON data.', {}, cause); }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !('version' in value) || value.version !== 1 || !('operations' in value) || !Array.isArray(value.operations)
        || Object.keys(value).some(key => !['version', 'operations'].includes(key))) fail('INVALID_DATA', 'Expected a version 1 batch payload.');
    if (value.operations.length > 256) fail('LIMIT_EXCEEDED', 'A batch payload may contain at most 256 operations.');
    const shapes: Record<string, readonly string[]> = {
        createCollection: [], dropCollection: [], insertOne: ['document'], insertMany: ['documents'],
        updateOne: ['id', 'fields'], replaceOne: ['id', 'fields'], deleteOne: ['id'],
        updateMany: ['query', 'fields'], deleteMany: ['query'],
    };
    for (const operation of value.operations as unknown[]) {
        if (!operation || typeof operation !== 'object' || Array.isArray(operation) || !('op' in operation)
            || typeof operation.op !== 'string' || !Object.hasOwn(shapes, operation.op)) fail('INVALID_DATA', 'Unknown batch operation.');
        const op = operation as Record<string, unknown>;
        const required = ['op', 'collection', ...shapes[operation.op]!];
        const allowed = ['updateMany', 'deleteMany'].includes(operation.op) ? [...required, 'view'] : required;
        if (required.some(key => !Object.hasOwn(op, key)) || Object.keys(op).some(key => !allowed.includes(key))) fail('INVALID_DATA', 'Invalid batch operation properties.');
        collectionName(op.collection);
        if ('id' in op) documentId(op.id);
        if ('fields' in op) updateFields(op.fields);
        if ('document' in op) fields(op.document);
        if ('documents' in op) {
            if (!Array.isArray(op.documents)) fail('INVALID_DATA', 'Expected a document list.');
            op.documents.forEach(fields);
        }
        if ('query' in op) checkedQuery(op.query as QueryInput);
        if ('view' in op) queryOptions({ view: op.view as 'raw' | 'typed' });
    }
    return value as BatchPayload;
}

function apply(tx: Transaction, operation: BatchOperation): unknown {
    if (operation.op === 'createCollection') return tx.createCollection(operation.collection);
    if (operation.op === 'dropCollection') return tx.dropCollection(operation.collection);
    const collection = tx.collection(operation.collection);
    switch (operation.op) {
        case 'insertOne': return collection.insertOne(operation.document);
        case 'insertMany': return collection.insertMany(operation.documents);
        case 'updateOne': return collection.updateOne(operation.id, operation.fields);
        case 'replaceOne': return collection.replaceOne(operation.id, operation.fields);
        case 'deleteOne': return collection.deleteOne(operation.id);
        case 'updateMany': return collection.updateMany(operation.query, operation.fields, operation.view === undefined ? {} : { view: operation.view });
        case 'deleteMany': return collection.deleteMany(operation.query, operation.view === undefined ? {} : { view: operation.view });
    }
}

export async function applyBatch(database: Stringbase, input: unknown): Promise<readonly unknown[]> {
    const payload = validateBatch(input);
    return database.batch(tx => Object.freeze(payload.operations.map(operation => apply(tx, operation))));
}
