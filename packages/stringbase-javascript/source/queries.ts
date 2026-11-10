import { fromIR, query, snapshot } from '@plurid/loque';
import type { QueryIR, ExpressionIR, PredicateIR } from '@plurid/loque';
import { fail, StringbaseError } from './errors';
import { requireCollection, typedView } from './model';
import type { DatabaseData, Document, QueryInput, QueryOptions } from './types';

export function queryOptions(options: QueryOptions = {}): 'raw' | 'typed' {
    if (options === null || typeof options !== 'object' || Object.keys(options).some(key => key !== 'view')
        || (options.view !== undefined && options.view !== 'raw' && options.view !== 'typed')) fail('INVALID_OPTIONS', 'Expected a raw or typed query view.');
    return options.view ?? 'raw';
}

export function checkedQuery(input: QueryInput = query()): QueryIR {
    try {
        const raw: unknown = 'toIR' in input ? input.toIR() : input;
        let nodes = 0;
        const visit = (value: unknown, depth: number): void => {
            if (++nodes > 4096 || depth > 64) fail('LIMIT_EXCEEDED', 'Query is too large or deeply nested.');
            if (value && typeof value === 'object') {
                for (const child of Object.values(value)) visit(child, depth + 1);
            }
        };
        visit(raw, 0);
        const ir = fromIR(raw).toIR();
        if (ir.steps.length > 256) fail('LIMIT_EXCEEDED', 'A query may contain at most 256 steps.');
        if (ir.steps.some(step => !['where', 'sort', 'skip', 'limit'].includes(step.op))) fail('INVALID_QUERY', 'A collection query must stay at document level.');
        let comparisons = 0;
        const expression = (item: ExpressionIR): void => {
            if (item.op === 'probability' || item.op === 'decision' || item.op === 'expected') fail('INVALID_QUERY', 'Judgment expressions are not supported by the database.');
        };
        const predicate = (item: PredicateIR): void => {
            if (item.op === 'and' || item.op === 'or') item.predicates.forEach(predicate);
            else if (item.op === 'not') predicate(item.predicate);
            else {
                if (++comparisons > 256) fail('LIMIT_EXCEEDED', 'A query may contain at most 256 comparisons.');
                if (item.op === 'exists' || item.op === 'in') expression(item.value);
                else if ('left' in item) { expression(item.left); expression(item.right); }
            }
        };
        for (const step of ir.steps) if (step.op === 'where') predicate(step.predicate);
        return ir;
    } catch (cause) {
        if (cause instanceof StringbaseError) throw cause;
        throw new StringbaseError('INVALID_QUERY', 'Invalid collection query.', {}, cause);
    }
}

export function select(data: DatabaseData, name: string, input?: QueryInput, options: QueryOptions = {}): readonly Document[] {
    const records = requireCollection(data, name);
    const view = queryOptions(options);
    const ir = checkedQuery(input);
    const source = view === 'typed' ? records.map(doc => typedView(doc, true)) : records;
    const selected = snapshot(source).select(fromIR({ version: 1, steps: [{ op: 'each' }, ...ir.steps] })).values();
    const byId = new Map(records.map(doc => [doc.id, doc]));
    return Object.freeze(selected.map(doc => byId.get((doc as { id: string }).id)!));
}
