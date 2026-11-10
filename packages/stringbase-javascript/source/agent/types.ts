import type { QueryIR } from '@plurid/loque';
import type { DatabaseData, Fields, Value } from '../types';

export interface FieldRule {
    readonly kind: 'string' | 'strings' | 'map';
    readonly required?: boolean;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly enum?: readonly string[];
}
export interface AgentPolicy {
    readonly version: string;
    readonly read: readonly string[];
    readonly write: readonly string[];
    readonly deny?: readonly string[];
    readonly schema: Readonly<Record<string, Readonly<Record<string, FieldRule>>>>;
    readonly maxMatches?: number;
    readonly maxOperations?: number;
    readonly maxResults?: number;
    readonly maxOutputBytes?: number;
}
/** A document-level Loque query, scoped to one collection. No executable code. */
export interface AgentProgram {
    readonly version: 1;
    readonly collection: string;
    readonly query: QueryIR;
    readonly fields?: readonly string[];
    readonly mutation?: { readonly op: 'merge'; readonly value: Fields };
    readonly limits?: { readonly maxMatches?: number; readonly maxOperations?: number };
}
export interface FieldChange {
    readonly collection: string;
    readonly id: string;
    readonly field: string;
    readonly before?: Value;
    readonly after?: Value;
}
export interface ValidationFinding {
    readonly collection: string;
    readonly id: string;
    readonly field: string;
    readonly message: string;
}
export interface Revision {
    readonly id: string;
    readonly parent: string | null;
    readonly snapshot: string;
    readonly kind: 'import' | 'apply' | 'promote' | 'revert';
    readonly actor: string;
    readonly createdAt: string;
    readonly sourceRevision: string;
    readonly policyHash: string;
    readonly runId?: string;
    readonly planId?: string;
    readonly approvalId?: string;
    readonly source?: string;
    readonly program?: AgentProgram;
    readonly changes: readonly FieldChange[];
}
export interface Run {
    readonly id: string;
    readonly actor: string;
    readonly label: string;
    readonly base: string;
    readonly head: string;
    readonly policyHash: string;
    readonly status: 'open' | 'submitted' | 'accepted' | 'rejected' | 'discarded';
}
export interface ChangePlan {
    readonly id: string;
    readonly runId: string;
    readonly revision: string;
    readonly policyHash: string;
    readonly program: AgentProgram;
    readonly matchCount: number;
    readonly changes: readonly FieldChange[];
    readonly findings: readonly ValidationFinding[];
}
export interface Proposal {
    readonly id: string;
    readonly runId: string;
    readonly revision: string;
    readonly target: string;
    readonly policyHash: string;
    readonly diffHash: string;
    readonly createdAt: string;
}
export interface Approval {
    readonly id: string;
    readonly proposalId: string;
    readonly reviewer: string;
    readonly target: string;
    readonly source: string;
    readonly policyHash: string;
    readonly diffHash: string;
    readonly createdAt: string;
}
export interface Receipt<T = unknown> {
    readonly requestId: string;
    readonly fingerprint: string;
    readonly operation: string;
    readonly actor: string;
    readonly createdAt: string;
    readonly result: T;
}
export interface Request { readonly requestId: string }
export interface ReviewerRequest extends Request { readonly reviewer: string }
export interface WorkspaceOptions {
    readonly directory: string;
    readonly mode?: 'readwrite' | 'readonly';
}
export interface CreateWorkspaceOptions extends WorkspaceOptions {
    readonly data: DatabaseData;
    readonly policy: AgentPolicy;
    readonly sourceRevision: string;
    readonly actor: string;
    readonly maxSnapshotBytes?: number;
    readonly maxWorkspaceBytes?: number;
}
export interface ImportSnapshotOptions extends Request {
    readonly data: DatabaseData;
    readonly sourceRevision: string;
    readonly actor: string;
    readonly expectedRevision: string;
}
export interface ForkOptions extends Request {
    readonly actor: string;
    readonly label?: string;
    readonly expectedRevision?: string;
}
export interface ReviewPage { readonly offset?: number; readonly limit?: number }
export interface ChangePage {
    readonly total: number;
    readonly changes: readonly FieldChange[];
    readonly nextOffset: number | null;
}
export interface ExportedChanges {
    readonly version: 1;
    readonly revision: string;
    readonly parent: string;
    readonly sourceRevision: string;
    readonly changes: readonly FieldChange[];
}

/** Persistent format; not exported from the package entry point. */
export interface Manifest {
    version: 1;
    accepted: string;
    policy: AgentPolicy;
    policyHash: string;
    policies: Record<string, AgentPolicy>;
    maxSnapshotBytes: number;
    maxWorkspaceBytes: number;
    revisions: Record<string, Revision>;
    runs: Record<string, Run>;
    plans: Record<string, ChangePlan>;
    proposals: Record<string, Proposal>;
    approvals: Record<string, Approval>;
    receipts: Record<string, Receipt>;
}
