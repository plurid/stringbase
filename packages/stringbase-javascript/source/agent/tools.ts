import { querySchema } from '@plurid/loque';
import type { JsonObject } from '@plurid/loque';
import { fail, StringbaseError } from '../errors';
import type { AgentProgram, ReviewPage } from './types';
import { immutable, mutable, object, shape, text } from './util';
import { Workspace } from './workspace';

const ref = (name: string) => ({ $ref: '#/$defs/' + name });
const identifier = { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' };
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const definitions = mutable(querySchema.$defs) as Record<string, JsonObject>;
definitions.expression = definitions.deterministicExpression!;
delete definitions.judgmentExpression;
const steps = definitions.step!.oneOf as unknown as { properties: { op: { const?: string; enum?: string[] } } }[];
definitions.step = { oneOf: steps.filter(step => step.properties.op.enum || ['where', 'sort'].includes(step.properties.op.const ?? '')) as unknown as JsonObject[] };
definitions.value = { anyOf: [{ type: 'string' }, { type: 'array', items: ref('value') }, { type: 'object', additionalProperties: ref('value') }] };
definitions.query = { ...definitions.query!, properties: { version: { const: 1 }, steps: { type: 'array', maxItems: 256, items: ref('step') } } };
const fields = { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string', minLength: 1, maxLength: 1024, pattern: '\\S' } };
const programProperties = {
    version: { const: 1 }, collection: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_-]*$' }, query: ref('query'), fields,
    mutation: { type: 'object', properties: { op: { const: 'merge' }, value: { type: 'object', propertyNames: { not: { const: 'id' } }, additionalProperties: ref('value') } }, required: ['op', 'value'], additionalProperties: false },
    limits: { type: 'object', properties: { maxMatches: { ...count, maximum: 10_000 }, maxOperations: { ...count, maximum: 10_000 } }, additionalProperties: false },
};
const required = ['version', 'collection', 'query'];
export const agentProgramSchema = immutable({ $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Stringbase agent program', type: 'object',
    properties: programProperties, required, additionalProperties: false,
    allOf: [{ if: { required: ['mutation'] }, then: { not: { required: ['fields'] } } }], $defs: definitions });
const queryProperties = { ...programProperties };
delete (queryProperties as Partial<typeof programProperties>).mutation;
const mutationProperties = { ...programProperties };
delete (mutationProperties as Partial<typeof programProperties>).fields;
const queryProgram = { type: 'object', properties: queryProperties, required, additionalProperties: false };
const mutationProgram = { type: 'object', properties: mutationProperties, required: [...required, 'mutation'], additionalProperties: false };

function schema(properties: object, required: readonly string[]) {
    return { type: 'object' as const, properties, required, additionalProperties: false, $defs: definitions };
}
const run = { runId: identifier };
const request = { requestId: { ...identifier, description: 'Unique workspace-wide request ID. Prefer a UUID; reuse it only for an identical retry.' } };
const pagination = { offset: count, limit: { ...count, minimum: 1, maximum: 1000 } };
function tool(name: string, description: string, inputSchema: ReturnType<typeof schema>, readOnly: boolean) {
    return { name: 'stringbase_' + name, description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
}
export const agentTools = immutable([
    tool('describe', 'Discover the workspace schema, permissions, revision, and limits. No record values are returned. Supply runId to describe an existing run.', schema(run, []), true),
    tool('fork', 'Start an isolated run from accepted data. Reuse requestId when retrying. The host binds your actor identity.', schema({ ...request, label: identifier, expectedRevision: identifier }, ['requestId']), false),
    tool('query', 'Read authorized records in your run using document-level Loque steps. Strings stay strings. Use fields to project readable fields; id is included. Pin expectedRevision when paging.', schema({ ...run, program: queryProgram, expectedRevision: identifier }, ['runId', 'program']), true),
    tool('plan', 'Preview a merge of existing record fields. Returns exact changes and validation findings without changing record data. Identifiers and unauthorized fields cannot be changed.', schema({ ...run, ...request, program: mutationProgram }, ['runId', 'requestId', 'program']), false),
    tool('apply', 'Apply a stored valid plan inside its original run revision. This does not publish to accepted data. Reuse requestId on retry.', schema({ ...run, ...request, planId: identifier }, ['runId', 'requestId', 'planId']), false),
    tool('diff', 'Review changes from your run base, identified by document ID and field. Paginate large reviews.', schema({ ...run, ...pagination }, ['runId']), true),
    tool('history', 'Read your own run history and recorded deterministic programs. Paginate large responses.', schema({ ...run, ...pagination }, ['runId']), true),
    tool('submit', 'Freeze your run and submit a proposal for host review. Approval and promotion are performed by the trusted host.', schema({ ...run, ...request }, ['runId', 'requestId']), false),
    tool('discard', 'Close an open run without changing accepted data.', schema({ ...run, ...request }, ['runId', 'requestId']), false),
]);

export interface AgentToolsOptions { readonly actor: string; readonly runIds?: readonly string[] }
export interface ToolResponse {
    readonly isError: boolean;
    readonly content: readonly { readonly type: 'text'; readonly text: string }[];
    readonly structuredContent: Readonly<Record<string, unknown>>;
}

/** Transport-neutral adapter. Each instance is bound to one host-selected actor and run grant. */
export function createAgentTools(workspace: Workspace, options: AgentToolsOptions) {
    text(options.actor, 'actor'); const actor = options.actor;
    const granted = new Set(options.runIds ?? []);
    return {
        tools: agentTools,
        async call(name: string, input: unknown = {}): Promise<ToolResponse> {
            try {
                const definition = agentTools.find(tool => tool.name === name);
                if (!definition) fail('CAPABILITY_DENIED', 'Tool is not available to agents.');
                const args = immutable(input); object(args, 'tool arguments');
                const specification = definition.inputSchema;
                shape(args, specification.required, Object.keys(specification.properties).filter(key => !specification.required.includes(key)));
                if (Object.hasOwn(args, 'requestId')) text(args.requestId, 'request ID');
                if (Object.hasOwn(args, 'expectedRevision')) text(args.expectedRevision, 'expected revision');
                let session: ReturnType<Workspace['agent']> | undefined;
                if (args.runId !== undefined) {
                    text(args.runId, 'run ID');
                    if (!granted.has(args.runId)) fail('CAPABILITY_DENIED', 'Run is not granted to this session.');
                    const run = await workspace.getRun(args.runId);
                    if (run.actor !== actor) fail('CAPABILITY_DENIED', 'Run belongs to another actor.');
                    session = workspace.agent(args.runId);
                }
                const req = { requestId: args.requestId as string };
                const page: ReviewPage = { ...(args.offset === undefined ? {} : { offset: args.offset as number }), ...(args.limit === undefined ? {} : { limit: args.limit as number }) };
                let result: unknown;
                switch (name) {
                    case 'stringbase_describe': {
                        const description = session ? await session.describe() : await workspace.describe();
                        const { directory: _directory, ...visible } = description;
                        void _directory; result = visible; break;
                    }
                    case 'stringbase_fork': {
                        const forked = await workspace.fork({ actor, ...req, ...(args.label === undefined ? {} : { label: args.label as string }), ...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision as string }) });
                        granted.add(forked.id); result = forked; break;
                    }
                    case 'stringbase_query': result = await session!.query(args.program as AgentProgram, args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision as string }); break;
                    case 'stringbase_plan': result = await session!.plan(args.program as AgentProgram, req); break;
                    case 'stringbase_apply': result = await session!.apply(args.planId as string, req); break;
                    case 'stringbase_diff': result = await session!.diff(page); break;
                    case 'stringbase_history': result = await session!.history(page); break;
                    case 'stringbase_submit': result = await session!.submit(req); break;
                    case 'stringbase_discard': result = await session!.discard(req); break;
                }
                const structuredContent = { ok: true, result };
                return { isError: false, structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
            } catch (cause) {
                const error = cause instanceof StringbaseError ? { code: cause.code, message: cause.message, details: cause.details,
                    retryable: cause.code === 'STRINGBASE_CONFLICT' || cause.code === 'STRINGBASE_LOCKED' }
                    : { code: 'STRINGBASE_INVALID_DATA', message: 'Invalid tool input or unavailable workspace.', details: {}, retryable: false };
                const structuredContent = { ok: false, error };
                return { isError: true, structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
            }
        },
    };
}
