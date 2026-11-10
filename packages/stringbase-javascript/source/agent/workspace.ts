import { randomUUID } from 'node:crypto';
import { fail, StringbaseError } from '../errors';
import { databaseData, define } from '../model';
import type { DatabaseData } from '../types';
import type { AgentProgram, Approval, ChangePage, ChangePlan, CreateWorkspaceOptions, ExportedChanges, ForkOptions, ImportSnapshotOptions, Manifest, Proposal, Request, ReviewPage, ReviewerRequest, Revision, Run, WorkspaceOptions } from './types';
import { authorizeChanges, differences, evaluate, limits, queryData, requireValid, schemaForDescription, validateData, validatePolicy, validateProgram } from './policy';
import { hash, immutable, integer, lookup, mutable, object, output, shape, text } from './util';
import { WorkspaceStore } from './storage';
import { readManifest } from './format';

const AGENT = Symbol('workspace.agent');
const now = (): string => new Date().toISOString();
const id = (): string => randomUUID();

function options(input: unknown, create: boolean): asserts input is WorkspaceOptions {
    object(input, 'workspace options');
    shape(input, create ? ['directory', 'data', 'policy', 'sourceRevision', 'actor'] : ['directory'], create ? ['mode', 'maxSnapshotBytes', 'maxWorkspaceBytes'] : ['mode']);
    text(input.directory, 'workspace directory', 4096);
    if (input.mode !== undefined && !['readwrite', 'readonly'].includes(input.mode as string)) fail('INVALID_OPTIONS', 'Invalid workspace mode.');
    if (create && input.mode === 'readonly') fail('INVALID_OPTIONS', 'Cannot create a readonly workspace.');
}

function page<T>(items: readonly T[], pagination: ReviewPage = {}): { total: number; items: readonly T[]; nextOffset: number | null } {
    object(pagination, 'page'); shape(pagination as Record<string, unknown>, [], ['offset', 'limit']);
    const offset = pagination.offset ?? 0; const limit = pagination.limit ?? 50;
    integer(offset, 'offset', 0); integer(limit, 'page limit', 1, 1000);
    return { total: items.length, items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null };
}
function changePage(changes: readonly import('./types').FieldChange[], pagination?: ReviewPage): ChangePage {
    const result = page(changes, pagination);
    return { total: result.total, changes: result.items, nextOffset: result.nextOffset };
}

export class Workspace {
    private tail: Promise<void> = Promise.resolve();
    private closed = false;
    private uncertain: unknown;
    private closing: Promise<void> | undefined;
    private constructor(private readonly store: WorkspaceStore, private state: Manifest) {}
    get directory(): string { return this.store.directory; }

    static async create(input: CreateWorkspaceOptions): Promise<Workspace> {
        options(input, true);
        const data = databaseData(input.data); const policy = validatePolicy(input.policy);
        text(input.sourceRevision, 'source revision', 4096); text(input.actor, 'actor');
        requireValid(data, policy);
        const maxSnapshotBytes = input.maxSnapshotBytes ?? 64 * 1024 * 1024;
        const maxWorkspaceBytes = input.maxWorkspaceBytes ?? 256 * 1024 * 1024;
        integer(maxSnapshotBytes, 'maxSnapshotBytes', 1, 64 * 1024 * 1024); integer(maxWorkspaceBytes, 'maxWorkspaceBytes');
        const revision = id(); const createdAt = now();
        const result = await WorkspaceStore.create(input.directory, data, snapshot => ({ version: 1, accepted: revision, policy, policyHash: hash(policy), policies: { [hash(policy)]: policy }, maxSnapshotBytes, maxWorkspaceBytes,
            revisions: { [revision]: { id: revision, parent: null, snapshot, kind: 'import', actor: input.actor, createdAt, sourceRevision: input.sourceRevision, policyHash: hash(policy), changes: [] } },
            runs: {}, plans: {}, proposals: {}, approvals: {}, receipts: {} }));
        return new Workspace(result.store, immutable(result.manifest));
    }

    static async open(input: WorkspaceOptions): Promise<Workspace> {
        options(input, false);
        const { store, value } = await WorkspaceStore.open(input.directory, input.mode === 'readonly');
        try {
            const state = readManifest(value);
            await store.recover(state);
            requireValid(await store.readSnapshot(state.revisions[state.accepted]!.snapshot, state.maxSnapshotBytes), state.policy);
            return new Workspace(store, state);
        } catch (cause) { await store.close(); throw cause; }
    }

    private enqueue<T>(operation: () => Promise<T> | T, write = false): Promise<T> {
        if (this.closed) return Promise.reject(new StringbaseError('CLOSED', 'Workspace is closed.'));
        if (this.uncertain) return Promise.reject(this.uncertain);
        if (write && this.store.readonly) return Promise.reject(new StringbaseError('READ_ONLY', 'Workspace is readonly.'));
        const result = this.tail.then(async () => {
            if (this.uncertain) throw this.uncertain;
            return operation();
        });
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }

    private mutate<T>(operation: string, actor: string, request: Request, input: unknown, apply: (state: Manifest) => Promise<T> | T): Promise<T> {
        text(actor, 'actor'); object(request, 'request'); text(request.requestId, 'request ID');
        const requestId = request.requestId;
        const fingerprint = hash({ operation, actor, input });
        return this.enqueue(async () => {
            if (['plan', 'apply', 'submit', 'discard'].includes(operation)) this.run(this.state, (input as { runId: string }).runId);
            const receipt = Object.hasOwn(this.state.receipts, requestId) ? this.state.receipts[requestId] : undefined;
            if (receipt) {
                if (receipt.fingerprint !== fingerprint) fail('CONFLICT', 'Request ID was already used with different input.');
                return immutable(receipt.result) as T;
            }
            const next = mutable(this.state);
            const result = immutable(await apply(next));
            define(next.receipts, requestId, { requestId, fingerprint, operation, actor, createdAt: now(), result });
            try { await this.store.commit(next); }
            catch (cause) {
                if (cause instanceof StringbaseError && cause.code === 'STRINGBASE_COMMIT_UNCERTAIN') this.uncertain = cause;
                throw cause;
            }
            this.state = immutable(next);
            return result;
        }, true);
    }

    private data(state: Manifest, revision: string): Promise<DatabaseData> {
        return this.store.readSnapshot(lookup(state.revisions, revision, 'revision').snapshot, state.maxSnapshotBytes);
    }

    private run(state: Manifest, runId: string, open = false): Run {
        const run = lookup(state.runs, runId, 'run');
        if (run.policyHash !== state.policyHash) fail('CAPABILITY_DENIED', 'Run policy has changed; fork a new run.');
        if (open && run.status !== 'open') fail('INVALID_STATE', 'Run is frozen or closed.');
        return run;
    }

    describe() {
        return this.enqueue(() => immutable({ version: 1, directory: this.directory, revision: this.state.accepted, policyHash: this.state.policyHash,
            policy: this.state.policy, schema: schemaForDescription(this.state.policy), limits: limits(this.state.policy),
            maxSnapshotBytes: this.state.maxSnapshotBytes, maxWorkspaceBytes: this.state.maxWorkspaceBytes }));
    }

    async importSnapshot(input: ImportSnapshotOptions): Promise<Revision> {
        input = immutable(input);
        const data = databaseData(input.data); text(input.sourceRevision, 'source revision', 4096); text(input.expectedRevision, 'expected revision');
        return this.mutate('import', input.actor, input, { data, sourceRevision: input.sourceRevision, expectedRevision: input.expectedRevision }, async state => {
            if (state.accepted !== input.expectedRevision) fail('CONFLICT', 'Accepted revision has changed.');
            requireValid(data, state.policy);
            const revision: Revision = { id: id(), parent: state.accepted, snapshot: await this.store.writeSnapshot(data, state), kind: 'import',
                actor: input.actor, createdAt: now(), sourceRevision: input.sourceRevision, policyHash: state.policyHash, changes: differences(await this.data(state, state.accepted), data) };
            state.revisions[revision.id] = revision; state.accepted = revision.id;
            return revision;
        });
    }

    async setPolicy(policy: unknown, request: ReviewerRequest): Promise<{ policyHash: string }> {
        const checked = validatePolicy(policy);
        return this.mutate('policy', request.reviewer, request, checked, async state => {
            if (checked.version === state.policy.version && hash(checked) !== state.policyHash) fail('INVALID_DATA', 'Changed policies require a new version.');
            requireValid(await this.data(state, state.accepted), checked);
            state.policy = checked; state.policyHash = hash(checked);
            state.policies[state.policyHash] = checked;
            return { policyHash: state.policyHash };
        });
    }

    async fork(input: ForkOptions): Promise<Run> {
        input = immutable(input);
        const label = input.label ?? 'agent run'; text(label, 'run label');
        if (input.expectedRevision !== undefined) text(input.expectedRevision, 'expected revision');
        return this.mutate('fork', input.actor, input, { label, expectedRevision: input.expectedRevision ?? null }, state => {
            if (input.expectedRevision !== undefined && input.expectedRevision !== state.accepted) fail('CONFLICT', 'Accepted revision has changed.');
            const run: Run = { id: id(), actor: input.actor, label, base: state.accepted, head: state.accepted, policyHash: state.policyHash, status: 'open' };
            state.runs[run.id] = run;
            return run;
        });
    }

    /** Host-created handle. Transport adapters must bind ownership before giving it to an agent. */
    agent(runId: string): AgentSession { text(runId, 'run ID'); return new AgentSession(this, runId); }

    getRun(runId: string): Promise<Run> { return this.enqueue(() => immutable(lookup(this.state.runs, runId, 'run'))); }

    [AGENT](runId: string, command: 'describe', input?: unknown): ReturnType<Workspace['describe']>;
    [AGENT](runId: string, command: 'query', input: unknown): Promise<ReturnType<typeof queryData> & { revision: string }>;
    [AGENT](runId: string, command: 'plan', input: { program: unknown; request: Request }): Promise<ChangePlan>;
    [AGENT](runId: string, command: 'apply', input: { planId: string; request: Request }): Promise<Revision>;
    [AGENT](runId: string, command: 'diff', input?: ReviewPage): Promise<ChangePage>;
    [AGENT](runId: string, command: 'history', input?: ReviewPage): Promise<ReturnType<typeof page<Revision>>>;
    [AGENT](runId: string, command: 'submit', input: Request): Promise<Proposal>;
    [AGENT](runId: string, command: 'discard', input: Request): Promise<Run>;
    [AGENT](runId: string, command: string, input?: unknown): Promise<unknown> {
        // Ownership belongs to the host-bound handle, never to model-supplied input.
        const owner = lookup(this.state.runs, runId, 'run').actor;
        if (command === 'plan') {
            const { program: supplied, request } = input as { program: unknown; request: Request };
            const program = validateProgram(supplied, true);
            return this.mutate('plan', owner, request, { runId, program }, async state => {
                const run = this.run(state, runId, true);
                const evaluated = evaluate(await this.data(state, run.head), state.policy, program);
                const plan: ChangePlan = { id: id(), runId, revision: run.head, policyHash: state.policyHash, program,
                    matchCount: evaluated.matchCount, changes: evaluated.changes, findings: evaluated.findings };
                output(plan, limits(state.policy).bytes);
                state.plans[plan.id] = plan;
                return plan;
            });
        }
        if (command === 'apply') {
            const { planId, request } = input as { planId: string; request: Request };
            text(planId, 'plan ID');
            return this.mutate('apply', owner, request, { runId, planId }, async state => {
                const run = this.run(state, runId, true); const plan = lookup(state.plans, planId, 'plan');
                if (plan.runId !== runId) fail('CAPABILITY_DENIED', 'Plan belongs to another run.');
                if (plan.revision !== run.head || plan.policyHash !== state.policyHash) fail('CONFLICT', 'Plan revision or policy has changed.');
                const result = evaluate(await this.data(state, run.head), state.policy, plan.program);
                requireValid(result.next, state.policy);
                if (hash(result.changes) !== hash(plan.changes)) fail('CONFLICT', 'Plan no longer matches its recorded changes.');
                const revision: Revision = { id: id(), parent: run.head, snapshot: await this.store.writeSnapshot(result.next, state), kind: 'apply', actor: owner,
                    createdAt: now(), sourceRevision: state.revisions[run.base]!.sourceRevision, policyHash: state.policyHash, runId, planId, program: plan.program, changes: result.changes };
                state.revisions[revision.id] = revision; state.runs[runId] = { ...run, head: revision.id };
                return output(revision, limits(state.policy).bytes);
            });
        }
        if (command === 'submit' || command === 'discard') {
            return this.mutate(command, owner, input as Request, { runId }, async state => {
                const run = this.run(state, runId, true);
                if (command === 'discard') { const next = { ...run, status: 'discarded' as const }; state.runs[runId] = next; return next; }
                const data = await this.data(state, run.head); requireValid(data, state.policy);
                const changes = differences(await this.data(state, run.base), data); authorizeChanges(state.policy, changes);
                const proposal: Proposal = { id: id(), runId, revision: run.head, target: run.base, policyHash: state.policyHash, diffHash: hash(changes), createdAt: now() };
                state.proposals[proposal.id] = proposal; state.runs[runId] = { ...run, status: 'submitted' };
                return proposal;
            });
        }
        return this.enqueue(async () => {
            const run = this.run(this.state, runId);
            const bytes = limits(this.state.policy).bytes;
            if (command === 'describe') return output({ version: 1, directory: this.directory, revision: run.head, policyHash: this.state.policyHash,
                policy: this.state.policy, schema: schemaForDescription(this.state.policy), limits: limits(this.state.policy),
                maxSnapshotBytes: this.state.maxSnapshotBytes, maxWorkspaceBytes: this.state.maxWorkspaceBytes }, bytes);
            if (command === 'query') {
                const request = input as { program: AgentProgram; expectedRevision?: string };
                if (request.expectedRevision !== undefined && request.expectedRevision !== run.head) fail('CONFLICT', 'Query revision has changed.');
                return output({ ...queryData(await this.data(this.state, run.head), this.state.policy, request.program), revision: run.head }, bytes);
            }
            if (command === 'diff') {
                // Old values are exposed only for fields that were readable when applied.
                const changes = differences(await this.data(this.state, run.base), await this.data(this.state, run.head));
                return output(changePage(changes, input as ReviewPage | undefined), bytes);
            }
            return output(page(this.lineage(this.state, run.head, run.base), input as ReviewPage | undefined), bytes);
        });
    }

    private async proposal(state: Manifest, proposalId: string) {
        const proposal = lookup(state.proposals, proposalId, 'proposal'); const run = this.run(state, proposal.runId);
        if (run.status !== 'submitted' || run.head !== proposal.revision) fail('INVALID_STATE', 'Proposal is no longer pending.');
        if (proposal.policyHash !== state.policyHash) fail('CAPABILITY_DENIED', 'Proposal policy has changed.');
        const source = await this.data(state, proposal.revision);
        const changes = differences(await this.data(state, proposal.target), source);
        if (hash(changes) !== proposal.diffHash) fail('CONFLICT', 'Proposal diff has changed.');
        authorizeChanges(state.policy, changes);
        return { proposal, run, source, changes, findings: validateData(source, state.policy) };
    }

    review(proposalId: string, pagination?: ReviewPage) {
        return this.enqueue(async () => {
            const result = await this.proposal(this.state, proposalId);
            return output({ proposal: result.proposal, ...changePage(result.changes, pagination), findings: result.findings,
                stale: result.proposal.target !== this.state.accepted }, limits(this.state.policy).bytes);
        });
    }

    async approve(proposalId: string, request: ReviewerRequest): Promise<Approval> {
        return this.mutate('approve', request.reviewer, request, { proposalId }, async state => {
            const result = await this.proposal(state, proposalId);
            if (state.accepted !== result.proposal.target) fail('CONFLICT', 'Accepted revision changed; start a new run and obtain fresh approval.');
            requireValid(result.source, state.policy);
            const approval: Approval = { id: id(), proposalId, reviewer: request.reviewer, target: state.accepted, source: result.proposal.revision,
                policyHash: state.policyHash, diffHash: result.proposal.diffHash, createdAt: now() };
            state.approvals[approval.id] = approval;
            return approval;
        });
    }

    async promote(approvalId: string, request: ReviewerRequest): Promise<Revision> {
        return this.mutate('promote', request.reviewer, request, { approvalId }, async state => {
            const approval = lookup(state.approvals, approvalId, 'approval');
            const result = await this.proposal(state, approval.proposalId);
            if (approval.target !== state.accepted || approval.source !== result.proposal.revision || approval.policyHash !== state.policyHash || approval.diffHash !== hash(result.changes)) fail('CONFLICT', 'Approval no longer matches source, target, or policy.');
            requireValid(result.source, state.policy);
            const revision: Revision = { id: id(), parent: state.accepted, source: result.proposal.revision,
                snapshot: state.revisions[result.proposal.revision]!.snapshot, kind: 'promote', actor: request.reviewer, createdAt: now(),
                sourceRevision: state.revisions[state.accepted]!.sourceRevision, policyHash: state.policyHash, runId: result.run.id, approvalId, changes: result.changes };
            state.revisions[revision.id] = revision; state.accepted = revision.id; state.runs[result.run.id] = { ...result.run, status: 'accepted' };
            return revision;
        });
    }

    async reject(proposalId: string, request: ReviewerRequest): Promise<Run> {
        return this.mutate('reject', request.reviewer, request, { proposalId }, async state => {
            const result = await this.proposal(state, proposalId);
            const run = { ...result.run, status: 'rejected' as const }; state.runs[run.id] = run;
            return run;
        });
    }

    exportChanges(revisionId?: string): Promise<ExportedChanges> {
        return this.enqueue(async () => {
            const revision = lookup(this.state.revisions, revisionId ?? this.state.accepted, 'revision');
            if (!['promote', 'revert'].includes(revision.kind) || !revision.parent) fail('INVALID_STATE', 'Only accepted promotion or revert revisions can be exported.');
            return output({ version: 1, revision: revision.id, parent: revision.parent, sourceRevision: revision.sourceRevision, changes: revision.changes }, 64 * 1024 * 1024);
        });
    }

    private lineage(state: Manifest, head: string, stop?: string): readonly Revision[] {
        const revisions: Revision[] = []; let current: string | null = head;
        while (current !== null && current !== stop) {
            const revision: Revision = lookup(state.revisions, current, 'revision'); revisions.push(revision); current = revision.parent;
        }
        return revisions;
    }

    history(pagination?: ReviewPage) { return this.enqueue(() => output(page(this.lineage(this.state, this.state.accepted), pagination), limits(this.state.policy).bytes)); }

    receipt(requestId: string) { return this.enqueue(() => immutable(lookup(this.state.receipts, requestId, 'receipt'))); }

    async revert(expectedRevision: string, request: ReviewerRequest): Promise<Revision> {
        return this.mutate('revert', request.reviewer, request, { expectedRevision }, async state => {
            if (state.accepted !== expectedRevision) fail('CONFLICT', 'Accepted revision has changed.');
            const current = state.revisions[state.accepted]!;
            if (current.kind !== 'promote' || !current.parent) fail('INVALID_STATE', 'V1 reverts only the current accepted promotion.');
            const target = state.revisions[current.parent]!;
            const next = await this.data(state, target.id); requireValid(next, state.policy);
            const revision: Revision = { id: id(), parent: current.id, source: target.id, snapshot: target.snapshot, kind: 'revert', actor: request.reviewer,
                createdAt: now(), sourceRevision: current.sourceRevision, policyHash: state.policyHash, changes: differences(await this.data(state, current.id), next) };
            state.revisions[revision.id] = revision; state.accepted = revision.id;
            return revision;
        });
    }

    replay(revisionId: string) {
        return this.enqueue(async () => {
            const revision = lookup(this.state.revisions, revisionId, 'revision');
            if (revision.kind !== 'apply' || !revision.program || !revision.parent) fail('INVALID_STATE', 'Replay requires an agent apply revision.');
            const replayed = evaluate(await this.data(this.state, revision.parent), lookup(this.state.policies, revision.policyHash, 'historical policy'), revision.program);
            const matches = hash(replayed.next) === hash(await this.data(this.state, revision.id));
            return immutable({ revision: revisionId, matches, findings: replayed.findings });
        });
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true;
        this.closing = this.tail.then(() => this.store.close());
        return this.closing;
    }
}

/** This handle can act only within its host-selected run. */
export class AgentSession {
    constructor(private readonly workspace: Workspace, readonly runId: string) { Object.freeze(this); }
    async describe() { return this.workspace[AGENT](this.runId, 'describe'); }
    async query(program: AgentProgram, options: { readonly expectedRevision?: string } = {}) {
        object(options, 'query options'); shape(options as Record<string, unknown>, [], ['expectedRevision']);
        if (options.expectedRevision !== undefined) text(options.expectedRevision, 'expected revision');
        return this.workspace[AGENT](this.runId, 'query', { program, ...options });
    }
    async plan(program: AgentProgram, request: Request) { return this.workspace[AGENT](this.runId, 'plan', { program, request }); }
    async apply(planId: string, request: Request) { return this.workspace[AGENT](this.runId, 'apply', { planId, request }); }
    async diff(pagination?: ReviewPage) { return this.workspace[AGENT](this.runId, 'diff', pagination); }
    async history(pagination?: ReviewPage) { return this.workspace[AGENT](this.runId, 'history', pagination); }
    async submit(request: Request) { return this.workspace[AGENT](this.runId, 'submit', request); }
    async discard(request: Request) { return this.workspace[AGENT](this.runId, 'discard', request); }
}
