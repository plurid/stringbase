import { isDeepStrictEqual } from 'node:util';
import { DeonPure } from '@plurid/deon/pure';
import type { DocumentNode, ValueNode } from '@plurid/deon/pure';
import { databaseData } from '../model';
import { fail, StringbaseError } from '../errors';
import type { DatabaseData, Value } from '../types';

const deon = new DeonPure();

function inspect(node: ValueNode): void {
    if ('reference' in node && node.reference.head.startsWith('$')) fail('FILE_FORMAT', 'Environment references are not supported in database files.');
    if (node.type === 'scalar') {
        if (/#\{\$/.test(node.value)) fail('FILE_FORMAT', 'Environment interpolation is not supported in database files.');
    } else if (node.type === 'map') {
        for (const entry of node.entries) {
            if (entry.type === 'spread-entry') {
                if (entry.reference.head.startsWith('$')) fail('FILE_FORMAT', 'Environment references are not supported.');
            } else inspect(entry.value);
        }
    } else if (node.type === 'list') {
        for (const item of node.items) {
            if (item.type === 'spread-item') {
                if (item.reference.head.startsWith('$')) fail('FILE_FORMAT', 'Environment references are not supported.');
            } else inspect(item);
        }
    } else if (node.type === 'structure') {
        for (const row of node.rows) for (const cell of row) inspect(cell);
    } else if (node.type === 'call') {
        for (const argument of node.arguments) inspect(argument.value);
    }
}

export function parseValue(source: string, sourceName = '<memory>'): Value {
    try {
        const ast: DocumentNode = deon.parseSyntax(source, sourceName);
        for (const declaration of ast.declarations) {
            if (declaration.type !== 'leaflink') fail('FILE_FORMAT', 'Imports and injections are not supported in database files.');
            inspect(declaration.value);
        }
        inspect(ast.root);
        return deon.parseSynchronous<Value>(source, { sourceName, allowFilesystem: false, allowNetwork: false, environment: {} });
    } catch (cause) {
        if (cause instanceof StringbaseError) throw cause;
        throw new StringbaseError('FILE_FORMAT', `Invalid Deon in '${sourceName}'.`, { filepath: sourceName }, cause);
    }
}

export function decode(bytes: Uint8Array, sourceName: string, maxBytes: number): DatabaseData {
    if (bytes.byteLength > maxBytes) fail('LIMIT_EXCEEDED', 'Database exceeds maxFileBytes.', { filepath: sourceName });
    let source: string;
    try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch (cause) { throw new StringbaseError('FILE_FORMAT', 'Database is not valid UTF-8.', { filepath: sourceName }, cause); }
    try { return databaseData(parseValue(source, sourceName)); }
    catch (cause) {
        if (cause instanceof StringbaseError && ['STRINGBASE_FILE_FORMAT', 'STRINGBASE_LIMIT_EXCEEDED', 'STRINGBASE_DUPLICATE_ID'].includes(cause.code)) throw cause;
        throw new StringbaseError('FILE_FORMAT', 'Invalid database shape.', { filepath: sourceName }, cause);
    }
}

/** Deon owns layout and escaping; every commit must reopen to the same value. */
export function encode(data: DatabaseData, maxBytes: number): Buffer {
    const text = deon.stringify(data);
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.byteLength > maxBytes) fail('LIMIT_EXCEEDED', 'Result exceeds maxFileBytes.');
    if (!isDeepStrictEqual(decode(bytes, '<commit>', maxBytes), data)) fail('FILE_FORMAT', 'Deon cannot round-trip this database.');
    return bytes;
}
