import { capability, programFromIR, fromIR, snapshot } from '@plurid/loque';
import type { ProgramIR } from '@plurid/loque';
import { fail, StringbaseError } from '../errors';
import { collectionName, databaseData, fields, own, same, copyValue, updateFields } from '../model';
import { checkedQuery, select } from '../queries';
import type { DatabaseData, Document, Value } from '../types';
import type { AgentPolicy, AgentProgram, FieldChange, FieldRule, ValidationFinding } from './types';
import { immutable, integer, object, shape, text } from './util';

export const limits = (policy: AgentPolicy) => ({
    matches: policy.maxMatches ?? 100,
    operations: policy.maxOperations ?? 256,
    results: policy.maxResults ?? 50,
    bytes: policy.maxOutputBytes ?? 256 * 1024,
});

export function validatePolicy(input: unknown): AgentPolicy {
    const policy = immutable(input);
    object(policy, 'policy');
    shape(policy, ['version', 'read', 'write', 'schema'], ['deny', 'maxMatches', 'maxOperations', 'maxResults', 'maxOutputBytes']);
    text(policy.version, 'policy version');
    for (const key of ['read', 'write', 'deny']) {
        if (key === 'deny' && !own(policy, key)) continue;
        if (!Array.isArray(policy[key]) || policy[key].length > 256) fail('INVALID_DATA', 'Expected bounded permission patterns.');
        for (const item of policy[key]) text(item, 'permission pattern', 1024);
    }
    for (const key of ['maxMatches', 'maxOperations', 'maxResults']) if (own(policy, key)) integer(policy[key], key, 1, 10_000);
    if (own(policy, 'maxOutputBytes')) integer(policy.maxOutputBytes, 'maxOutputBytes', 1024, 4 * 1024 * 1024);
    object(policy.schema, 'schema');
    if (Object.keys(policy.schema).length > 256) fail('LIMIT_EXCEEDED', 'Too many schema collections.');
    for (const [name, definition] of Object.entries(policy.schema)) {
        collectionName(name); object(definition, 'collection schema');
        if (Object.keys(definition).length > 256) fail('LIMIT_EXCEEDED', 'Too many fields.');
        for (const [name, raw] of Object.entries(definition)) {
            text(name, 'field', 1024); object(raw, 'field rule');
            shape(raw, ['kind'], ['required', 'minLength', 'maxLength', 'enum']);
            if (!['string', 'strings', 'map'].includes(raw.kind as string)) fail('INVALID_DATA', 'Unknown field kind.');
            if (own(raw, 'required') && typeof raw.required !== 'boolean') fail('INVALID_DATA', 'required must be boolean.');
            for (const key of ['minLength', 'maxLength']) if (own(raw, key)) integer(raw[key], key, 0);
            if (typeof raw.minLength === 'number' && typeof raw.maxLength === 'number' && raw.minLength > raw.maxLength) fail('INVALID_DATA', 'Invalid field length range.');
            if (own(raw, 'enum') && (!Array.isArray(raw.enum) || raw.enum.length > 256 || raw.enum.some(item => typeof item !== 'string'))) fail('INVALID_DATA', 'Expected a bounded string enum.');
        }
    }
    const result = policy as unknown as AgentPolicy;
    try { grant(result); } catch (cause) { throw new StringbaseError('INVALID_DATA', 'Invalid capability patterns.', {}, cause); }
    return result;
}

function grant(policy: AgentPolicy) {
    return capability({ read: policy.read, write: policy.write, deny: policy.deny ?? [], mutations: ['merge'],
        judgments: [], maxMatches: limits(policy).matches, maxOperations: limits(policy).operations, maxEvaluations: 0 });
}

export function validateProgram(input: unknown, mutation: boolean): AgentProgram {
    const value = immutable(input);
    object(value, 'agent program');
    shape(value, ['version', 'collection', 'query'], ['fields', 'mutation', 'limits']);
    if (value.version !== 1) fail('INVALID_QUERY', 'Expected an agent program version 1.');
    collectionName(value.collection);
    const query = checkedQuery(value.query as AgentProgram['query']);
    if (mutation !== own(value, 'mutation')) fail('INVALID_QUERY', mutation ? 'Planning requires a merge mutation.' : 'Queries cannot mutate.');
    if (own(value, 'fields')) {
        if (mutation || !Array.isArray(value.fields) || !value.fields.length || value.fields.length > 256) fail('INVALID_QUERY', 'fields is a nonempty query projection.');
        for (const key of value.fields) text(key, 'projection field', 1024);
    }
    if (mutation) {
        object(value.mutation, 'mutation'); shape(value.mutation, ['op', 'value']);
        if (value.mutation.op !== 'merge') fail('CAPABILITY_DENIED', 'Agents may only merge existing document fields.');
        updateFields(value.mutation.value);
    }
    if (own(value, 'limits')) {
        object(value.limits, 'limits'); shape(value.limits, [], ['maxMatches', 'maxOperations']);
        for (const key of Object.keys(value.limits)) integer(value.limits[key], key, 0, 10_000);
    }
    return immutable({ ...value, query }) as unknown as AgentProgram;
}

function authorize(policy: AgentPolicy, program: ProgramIR): void {
    const violations = grant(policy).check(programFromIR(program));
    if (violations.length) fail('CAPABILITY_DENIED', 'Program exceeds its capability.', { violations });
}

function rootQuery(program: AgentProgram) {
    return { version: 1 as const, steps: [{ op: 'field' as const, key: program.collection }, { op: 'each' as const }, ...program.query.steps] };
}

export function queryData(data: DatabaseData, policy: AgentPolicy, input: unknown): { documents: readonly Document[]; revision?: string; nextSkip: number | null } {
    const program = validateProgram(input, false);
    const bounds = limits(policy);
    const bounded = { ...program, query: { version: 1 as const, steps: [...program.query.steps, { op: 'limit' as const, count: Math.min(bounds.results, program.limits?.maxMatches ?? bounds.matches, bounds.matches) }] } };
    const root = rootQuery(bounded);
    if (program.fields) {
        for (const key of new Set(['id', ...program.fields])) authorize(policy, { version: 1, query: { ...root, steps: [...root.steps, { op: 'field', key }] } });
    } else authorize(policy, { version: 1, query: root });
    const selected = select(data, program.collection, bounded.query);
    const documents = program.fields ? selected.map(doc => fields(Object.fromEntries([...new Set(['id', ...program.fields!])].filter(key => own(doc, key)).map(key => [key, doc[key]]))) as Document) : selected;
    // A full page may have a successor. Paging is always against the returned revision.
    const skipped = program.query.steps.reduce((total, step) => step.op === 'skip' ? total + step.count : total, 0);
    return { documents, nextSkip: selected.length === Math.min(bounds.results, program.limits?.maxMatches ?? bounds.matches, bounds.matches) && selected.length > 0 ? skipped + selected.length : null };
}

export function validateData(data: DatabaseData, policy: AgentPolicy): readonly ValidationFinding[] {
    const findings: ValidationFinding[] = [];
    for (const [collection, documents] of Object.entries(data)) {
        const schema = own(policy.schema, collection) ? policy.schema[collection]! : undefined;
        for (const doc of documents) {
            if (!schema) { findings.push({ collection, id: doc.id, field: '', message: 'Collection has no schema.' }); continue; }
            for (const key of Object.keys(doc)) if (key !== 'id' && !own(schema, key)) findings.push({ collection, id: doc.id, field: key, message: 'Field has no schema.' });
            for (const [field, rule] of Object.entries(schema)) {
                const present = own(doc, field);
                if (!present) { if (rule.required) findings.push({ collection, id: doc.id, field, message: 'Required field is missing.' }); continue; }
                const value = doc[field]!;
                const strings = typeof value === 'string' ? [value] : Array.isArray(value) ? value : Object.values(value);
                const kindValid = rule.kind === 'string' ? typeof value === 'string' : rule.kind === 'strings' ? Array.isArray(value) && strings.every(item => typeof item === 'string') : typeof value === 'object' && !Array.isArray(value) && strings.every(item => typeof item === 'string');
                const length = typeof value === 'string' ? [...value].length : Array.isArray(value) ? value.length : Object.keys(value).length;
                if (!kindValid || (rule.minLength !== undefined && length < rule.minLength) || (rule.maxLength !== undefined && length > rule.maxLength)
                    || (rule.enum && strings.some(item => typeof item !== 'string' || !rule.enum!.includes(item)))) findings.push({ collection, id: doc.id, field, message: 'Field violates its declared kind, length, or enum.' });
            }
        }
    }
    return immutable(findings);
}

export function requireValid(data: DatabaseData, policy: AgentPolicy): void {
    const findings = validateData(data, policy);
    if (findings.length) fail('VALIDATION_FAILED', 'Data violates the workspace schema.', { total: findings.length, findings: findings.slice(0, 20) });
}

const equal = (a: Value | undefined, b: Value | undefined): boolean => a === undefined || b === undefined ? a === b : same(copyValue(a), copyValue(b));

export function differences(before: DatabaseData, after: DatabaseData): readonly FieldChange[] {
    const changes: FieldChange[] = [];
    for (const collection of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
        const old = new Map((before[collection] ?? []).map(doc => [doc.id, doc]));
        const next = new Map((after[collection] ?? []).map(doc => [doc.id, doc]));
        for (const id of [...new Set([...old.keys(), ...next.keys()])].sort()) {
            const previous = old.get(id); const current = next.get(id);
            for (const field of [...new Set([...Object.keys(previous ?? {}), ...Object.keys(current ?? {})])].sort()) {
                if (field === 'id') continue;
                const a = previous?.[field]; const b = current?.[field];
                if (!equal(a, b)) changes.push({ collection, id, field, ...(a === undefined ? {} : { before: a }), ...(b === undefined ? {} : { after: b }) });
            }
        }
    }
    return immutable(changes);
}

export function evaluate(data: DatabaseData, policy: AgentPolicy, input: unknown) {
    const program = validateProgram(input, true);
    const root = rootQuery(program);
    authorize(policy, { version: 1, query: root, mutation: program.mutation!, ...(program.limits ? { limits: program.limits } : {}) });
    // Plans contain old values: a write grant alone must not reveal protected data.
    for (const key of Object.keys(program.mutation!.value)) authorize(policy, { version: 1, query: { ...root, steps: [...root.steps, { op: 'field', key }] } });
    const selected = snapshot(data).select(fromIR(root));
    const matchCount = selected.count();
    if (matchCount > Math.min(limits(policy).matches, program.limits?.maxMatches ?? Infinity)) fail('LIMIT_EXCEEDED', 'Too many matched documents.');
    const plan = selected.plan(program.mutation!);
    if (plan.operations.length > Math.min(limits(policy).operations, program.limits?.maxOperations ?? Infinity)) fail('LIMIT_EXCEEDED', 'Too many operations.');
    const next = databaseData(plan.apply().value);
    return { program, next, matchCount, changes: differences(data, next), findings: validateData(next, policy) };
}

export function authorizeChanges(policy: AgentPolicy, changes: readonly FieldChange[]): void {
    for (const change of changes) {
        const query = { version: 1 as const, steps: [{ op: 'field' as const, key: change.collection }, { op: 'each' as const }] };
        if (change.after === undefined) fail('CAPABILITY_DENIED', 'Agent proposals cannot remove fields.');
        authorize(policy, { version: 1, query, mutation: { op: 'merge', value: { [change.field]: change.after } } });
    }
}

export function schemaForDescription(policy: AgentPolicy): Readonly<Record<string, Readonly<Record<string, FieldRule>>>> {
    // The host-defined schema is descriptive; data access is independently checked by Loque.
    return immutable(policy.schema);
}
