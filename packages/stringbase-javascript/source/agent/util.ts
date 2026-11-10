import { createHash } from 'node:crypto';
import { snapshot } from '@plurid/loque';
import { fail, StringbaseError } from '../errors';

export function immutable<T>(input: T): T {
    try { return snapshot(input).value as T; }
    catch (cause) { throw new StringbaseError('INVALID_DATA', 'Expected ordinary JSON data without accessors, cycles, or unsupported values.', {}, cause); }
}
export function mutable<T>(input: T): T { return JSON.parse(JSON.stringify(input)) as T; }
export function canonical(input: unknown): string {
    const value = snapshot(input).value;
    const visit = (item: typeof value): string => {
        if (item === null || typeof item !== 'object') return JSON.stringify(item);
        if (Array.isArray(item)) return '[' + item.map(visit).join(',') + ']';
        return '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + visit((item as Record<string, typeof value>)[key]!)).join(',') + '}';
    };
    return visit(value);
}
export const hash = (input: unknown): string => createHash('sha256').update(canonical(input)).digest('hex');
export const byteHash = (input: Uint8Array): string => createHash('sha256').update(input).digest('hex');
export function text(input: unknown, label: string, max = 256): asserts input is string {
    if (typeof input !== 'string' || !input.trim() || !input.isWellFormed() || input.length > max) fail('INVALID_DATA', 'Invalid ' + label + '.');
}
export function object(input: unknown, label: string): asserts input is Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_DATA', 'Expected ' + label + ' object.');
}
export function shape(input: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
    if (required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !required.includes(key) && !optional.includes(key))) fail('INVALID_DATA', 'Unexpected or missing properties.');
}
export function integer(input: unknown, label: string, min = 1, max = Number.MAX_SAFE_INTEGER): asserts input is number {
    if (!Number.isSafeInteger(input) || (input as number) < min || (input as number) > max) fail('INVALID_DATA', 'Invalid ' + label + '.');
}
export function lookup<T>(map: Readonly<Record<string, T>>, id: string, label: string): T {
    text(id, label);
    if (!Object.hasOwn(map, id)) fail('NOT_FOUND', label + ' not found.');
    return map[id]!;
}
export function output<T>(value: T, maximum: number): T {
    if (Buffer.byteLength(JSON.stringify(value)) > maximum) fail('LIMIT_EXCEEDED', 'Response exceeds maxOutputBytes; request a smaller page or projection.');
    return immutable(value);
}
