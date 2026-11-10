import { StringbaseError, fail } from '../errors';
import { collectionName, copyValue, documentId } from '../model';
import type { Manifest, Revision } from './types';
import { validatePolicy, validateProgram } from './policy';
import { hash, immutable, integer, lookup, object, shape, text } from './util';

/** Validate persisted references before any snapshot path can be constructed. */
export function readManifest(input: unknown): Manifest {
    try {
        const value = immutable(input);
        object(value, 'manifest');
        shape(value, ['version', 'accepted', 'policy', 'policyHash', 'policies', 'maxSnapshotBytes', 'maxWorkspaceBytes', 'revisions', 'runs', 'plans', 'proposals', 'approvals', 'receipts']);
        if (value.version !== 1) fail('INVALID_DATA', 'Unsupported workspace format.');
        integer(value.maxSnapshotBytes, 'maxSnapshotBytes', 1, 64 * 1024 * 1024);
        integer(value.maxWorkspaceBytes, 'maxWorkspaceBytes');
        const policy = validatePolicy(value.policy);
        if (hash(policy) !== value.policyHash) fail('INVALID_DATA', 'Policy digest mismatch.');
        for (const name of ['revisions', 'runs', 'plans', 'proposals', 'approvals', 'receipts']) {
            object(value[name], name);
            for (const [id, entry] of Object.entries(value[name])) {
                text(id, 'registry key'); object(entry, 'registry entry');
                if (name !== 'receipts' && entry.id !== id) fail('INVALID_DATA', 'Registry ID mismatch.');
            }
        }
        const state = value as unknown as Manifest;
        object(state.policies, 'historical policies');
        for (const [digest, policy] of Object.entries(state.policies)) if (hash(validatePolicy(policy)) !== digest) fail('INVALID_DATA', 'Historical policy digest mismatch.');
        lookup(state.policies, state.policyHash, 'current policy');
        lookup(state.revisions, state.accepted, 'accepted revision');
        for (const revision of Object.values(state.revisions)) {
            shape(revision as unknown as Record<string, unknown>, ['id', 'parent', 'snapshot', 'kind', 'actor', 'createdAt', 'sourceRevision', 'policyHash', 'changes'], ['runId', 'source', 'program', 'planId', 'approvalId']);
            if (!/^[a-f0-9]{64}$/.test(revision.snapshot) || !['import', 'apply', 'promote', 'revert'].includes(revision.kind)) fail('INVALID_DATA', 'Invalid revision.');
            text(revision.actor, 'actor'); text(revision.createdAt, 'timestamp'); text(revision.sourceRevision, 'source revision', 4096);
            lookup(state.policies, revision.policyHash, 'revision policy');
            if (revision.parent !== null) lookup(state.revisions, revision.parent, 'parent revision');
            if (revision.source !== undefined) lookup(state.revisions, revision.source, 'source revision');
            if (revision.program) validateProgram(revision.program, true);
            if (!Array.isArray(revision.changes)) fail('INVALID_DATA', 'Invalid change list.');
            for (const change of revision.changes) {
                object(change, 'field change'); shape(change, ['collection', 'id', 'field'], ['before', 'after']);
                collectionName(change.collection); documentId(change.id); text(change.field, 'field', 1024);
                if (Object.hasOwn(change, 'before')) copyValue(change.before);
                if (Object.hasOwn(change, 'after')) copyValue(change.after);
            }
        }
        // Linear parent-graph validation, including disconnected agent histories.
        const complete = new Set<string>();
        for (const revision of Object.values(state.revisions)) {
            const pending = new Set<string>(); let current: Revision | undefined = revision;
            while (current && !complete.has(current.id)) {
                if (pending.has(current.id)) fail('INVALID_DATA', 'Revision parent cycle.');
                pending.add(current.id);
                current = current.parent === null ? undefined : state.revisions[current.parent];
            }
            for (const id of pending) complete.add(id);
        }
        for (const run of Object.values(state.runs)) {
            shape(run as unknown as Record<string, unknown>, ['id', 'actor', 'label', 'base', 'head', 'policyHash', 'status']);
            lookup(state.revisions, run.base, 'run base'); lookup(state.revisions, run.head, 'run head');
            text(run.actor, 'run actor'); text(run.label, 'run label');
            if (!['open', 'submitted', 'accepted', 'rejected', 'discarded'].includes(run.status) || !/^[a-f0-9]{64}$/.test(run.policyHash)) fail('INVALID_DATA', 'Invalid run.');
        }
        for (const plan of Object.values(state.plans)) {
            shape(plan as unknown as Record<string, unknown>, ['id', 'runId', 'revision', 'policyHash', 'program', 'matchCount', 'changes', 'findings']);
            lookup(state.runs, plan.runId, 'plan run'); lookup(state.revisions, plan.revision, 'plan revision');
            validateProgram(plan.program, true); integer(plan.matchCount, 'match count', 0);
            if (!Array.isArray(plan.changes) || !Array.isArray(plan.findings)) fail('INVALID_DATA', 'Invalid plan report.');
        }
        for (const proposal of Object.values(state.proposals)) {
            shape(proposal as unknown as Record<string, unknown>, ['id', 'runId', 'revision', 'target', 'policyHash', 'diffHash', 'createdAt']);
            lookup(state.runs, proposal.runId, 'proposal run'); lookup(state.revisions, proposal.revision, 'proposal revision'); lookup(state.revisions, proposal.target, 'proposal target');
        }
        for (const approval of Object.values(state.approvals)) {
            shape(approval as unknown as Record<string, unknown>, ['id', 'proposalId', 'reviewer', 'target', 'source', 'policyHash', 'diffHash', 'createdAt']);
            lookup(state.proposals, approval.proposalId, 'approved proposal'); text(approval.reviewer, 'reviewer');
        }
        for (const [id, receipt] of Object.entries(state.receipts)) {
            shape(receipt as unknown as Record<string, unknown>, ['requestId', 'fingerprint', 'operation', 'actor', 'createdAt', 'result']);
            if (receipt.requestId !== id || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)) fail('INVALID_DATA', 'Invalid receipt.');
        }
        return state;
    } catch (cause) { throw new StringbaseError('FILE_FORMAT', 'Invalid workspace manifest.', {}, cause); }
}
