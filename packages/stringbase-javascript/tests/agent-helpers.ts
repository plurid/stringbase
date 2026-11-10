import { afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../source/agent';
import type { AgentPolicy, AgentProgram, CreateWorkspaceOptions } from '../source/agent';
import type { Fields } from '../source';

export const policy: AgentPolicy = {
    version: 'catalog-1', read: ['/products/*'],
    write: ['/products/*/description', '/products/*/category', '/products/*/tags'],
    schema: { products: {
        description: { kind: 'string', required: true, minLength: 1, maxLength: 120 },
        category: { kind: 'string', enum: ['home', 'tools'] },
        tags: { kind: 'strings', maxLength: 10 }, sku: { kind: 'string' },
    } },
};
export const data = { products: [{ id: '01', description: 'Old description', category: 'home', tags: ['old'], sku: 'SKU-01' }, { id: '02', description: 'Second product', category: 'tools', tags: [], sku: 'SKU-02' }] };
export const queryProgram: AgentProgram = { version: 1, collection: 'products', query: { version: 1, steps: [] } };
export function program(value: Fields = { description: 'Improved description' }): AgentProgram {
    return { ...queryProgram, query: { version: 1, steps: [{ op: 'where', predicate: { op: 'eq', left: { op: 'field', path: ['id'] }, right: { op: 'literal', value: '01' } } }] }, mutation: { op: 'merge', value } };
}
let requestNumber = 0;
export const request = () => ({ requestId: 'request-' + ++requestNumber });
export const reviewer = () => ({ ...request(), reviewer: 'human:reviewer' });

export function workspaceFixture() {
    let directory = ''; const handles: Workspace[] = [];
    beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'stringbase-agent-')); });
    afterEach(async () => { vi.restoreAllMocks(); await Promise.all(handles.map(handle => handle.close())); await rm(directory, { recursive: true, force: true }); });
    return {
        get directory() { return directory; },
        get filepath() { return join(directory, 'workspace'); },
        track(handle: Workspace) { handles.push(handle); return handle; },
        async create(options: Partial<CreateWorkspaceOptions> = {}) {
            const handle = await Workspace.create({ directory: join(directory, 'workspace'), data, policy, sourceRevision: 'source-1', actor: 'host:importer', ...options });
            handles.push(handle); return handle;
        },
        async open(mode: 'readonly' | 'readwrite' = 'readwrite') { const handle = await Workspace.open({ directory: join(directory, 'workspace'), mode }); handles.push(handle); return handle; },
    };
}
