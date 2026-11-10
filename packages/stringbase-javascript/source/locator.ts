import { and, or, field, literal, fromIR } from '@plurid/loque';
import type { PredicateIR, QueryIR, PathSegment } from '@plurid/loque';
import { typer } from '@plurid/deon/pure';
import { StringbaseError, fail } from './errors';
import { collectionName } from './model';
import { queryOptions } from './queries';
import type { QueryOptions } from './types';

interface Token { kind: 'word' | 'string' | 'punct' | 'end'; value: string; start: number; end: number }

export function parseLocator(source: string, options: QueryOptions = {}): { collection: string; query: QueryIR } {
    const view = queryOptions(options);
    if (typeof source !== 'string') fail('INVALID_LOCATOR', 'A locator must be a string.');
    if (Buffer.byteLength(source, 'utf8') > 16 * 1024) fail('LIMIT_EXCEEDED', 'A locator may contain at most 16 KiB.');
    let offset = 0;
    const error = (message: string, at = offset): never => {
        const prefix = source.slice(0, at).split('\n');
        throw new StringbaseError('INVALID_LOCATOR', message, { offset: at, line: prefix.length, column: [...prefix[prefix.length - 1]!].length + 1 });
    };
    const tokens: Token[] = [];
    while (offset < source.length) {
        if (/[ \t\r\n]/.test(source[offset]!)) { offset++; continue; }
        const start = offset;
        const c = source[offset++]!;
        if (c === "'") {
            let value = '';
            let closed = false;
            while (offset < source.length) {
                const next = source[offset++]!;
                if (next === "'") { closed = true; break; }
                if (next === '\n' || next === '\r') error('Quoted locator strings cannot cross a newline.', start);
                if (next !== '\\') { value += next; continue; }
                const escaped = source[offset++];
                if (escaped === undefined) error('Unterminated escape.', start);
                if (escaped === 'u' && source[offset] === '{') {
                    const close = source.indexOf('}', ++offset);
                    if (close < 0) error('Unterminated Unicode escape.', start);
                    const hex = source.slice(offset, close);
                    const point = Number.parseInt(hex, 16);
                    if (!/^[\da-fA-F]{1,6}$/.test(hex) || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) error('Invalid Unicode escape.', start);
                    value += String.fromCodePoint(point);
                    offset = close + 1;
                } else {
                    const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', "'": "'", '\\': '\\' };
                    value += Object.hasOwn(escapes, escaped!) ? escapes[escaped!] : `\\${escaped}`;
                }
            }
            if (!closed) error('Unterminated quoted string.', start);
            tokens.push({ kind: 'string', value, start, end: offset });
        } else if ('.{}[]()&|:!<>='.includes(c)) {
            let value = c;
            if ((c === '<' || c === '>') && source[offset] === '=') value += source[offset++];
            else if (c === '!' && source[offset] === ':') value += source[offset++];
            tokens.push({ kind: 'punct', value, start, end: offset });
        } else {
            while (offset < source.length && !/[ \t\r\n'.{}[\]()&|:!<>=]/.test(source[offset]!)) offset++;
            tokens.push({ kind: 'word', value: source.slice(start, offset), start, end: offset });
        }
    }
    tokens.push({ kind: 'end', value: '', start: source.length, end: source.length });
    let position = 0;
    let groups = 0;
    let predicates = 0;
    const peek = (): Token => tokens[position]!;
    const take = (): Token => tokens[position++]!;
    const match = (value: string): boolean => { if (peek().value !== value) return false; take(); return true; };
    const expect = (value: string): void => { if (!match(value)) error(`Expected '${value}'.`, peek().start); };
    const name = (): string => {
        const token = take();
        if (token.kind !== 'word' && token.kind !== 'string') error('Expected a field name.', token.start);
        return token.value;
    };
    const path = (): PathSegment[] => {
        if (!match('{')) return [name()];
        const segments: PathSegment[] = [name()];
        while (peek().value !== '}') {
            if (match('.')) segments.push(name());
            else if (match('[')) {
                const part = take();
                if (part.kind === 'string') segments.push(part.value);
                else if (part.kind === 'word' && /^\d+$/.test(part.value) && Number.isSafeInteger(Number(part.value))) segments.push(Number(part.value));
                else error('Expected a quoted key or nonnegative list index.', part.start);
                expect(']');
            } else error('Expected a path separator or closing brace.', peek().start);
        }
        expect('}');
        return segments;
    };
    const primary = (): PredicateIR => {
        if (match('(')) {
            if (++groups > 32) fail('LIMIT_EXCEEDED', 'Locator groups may nest at most 32 levels.');
            const result = disjunction();
            expect(')'); groups--;
            return result;
        }
        if (++predicates > 256) fail('LIMIT_EXCEEDED', 'A locator may contain at most 256 predicates.');
        const segments = path();
        const operator = take();
        const operators: Record<string, 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'> = { ':': 'eq', '!:': 'ne', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' };
        if (!Object.hasOwn(operators, operator.value)) error('Expected a comparison operator.', operator.start);
        const operand = take();
        if (operand.kind !== 'word' && operand.kind !== 'string') error('Expected a comparison value.', operand.start);
        let text = operand.value;
        let end = operand.end;
        while (operand.kind === 'word' && peek().value === '.' && peek().start === end) {
            text += take().value;
            const next = take();
            if (next.kind !== 'word' || next.start !== end + 1) error('Invalid bare value.', next.start);
            text += next.value; end = next.end;
        }
        const value = view === 'typed' && operand.kind === 'word' && !(segments.length === 1 && segments[0] === 'id') ? typer<string | boolean | number>(text) : text;
        return { op: operators[operator.value]!, left: field(segments[0]!, ...segments.slice(1)), right: literal(value) };
    };
    const conjunction = (): PredicateIR => {
        const parts = [primary()];
        while (match('&')) parts.push(primary());
        return parts.length === 1 ? parts[0]! : and(...parts);
    };
    const disjunction = (): PredicateIR => {
        const parts = [conjunction()];
        while (match('|')) parts.push(conjunction());
        return parts.length === 1 ? parts[0]! : or(...parts);
    };
    const collection = name();
    try { collectionName(collection); } catch { error('Invalid collection name.', 0); }
    const steps: QueryIR['steps'] = peek().kind === 'end' ? [] : (expect('.'), [{ op: 'where', predicate: disjunction() }]);
    if (peek().kind !== 'end') error('Unexpected locator content.', peek().start);
    return { collection, query: fromIR({ version: 1, steps }).toIR() };
}
