import { describe, expect, it, vi } from 'vitest';
import { chmod, link, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import Stringbase from '../source';
import { Workspace } from '../source/agent';
import { fileIO } from '../source/storage/file';
import { program, queryProgram, request, workspaceFixture } from './agent-helpers';

describe('workspace publication and recovery', () => {
    const f = workspaceFixture();
    it('locks writers, allows readonly snapshots and preserves manifest permissions', async () => {
        const workspace = await f.create();
        await expect(Workspace.open({ directory: f.filepath })).rejects.toMatchObject({ code: 'STRINGBASE_LOCKED' });
        const reader = await f.open('readonly'); const initial = (await reader.describe()).revision;
        const run = await workspace.fork({ actor: 'agent', ...request() });
        await chmod(join(f.filepath, 'manifest.deon'), 0o640);
        await workspace.agent(run.id).plan(program(), request());
        expect((await stat(join(f.filepath, 'manifest.deon'))).mode & 0o777).toBe(0o640);
        expect((await reader.describe()).revision).toBe(initial);
        await expect(reader.receipt('missing')).rejects.toMatchObject({ code: 'STRINGBASE_NOT_FOUND' });
        await expect(Workspace.create({ directory: f.filepath } as never)).rejects.toBeInstanceOf(Error);
    });

    it('leaves both branch head and receipt unchanged after a failed snapshot publication', async () => {
        const workspace = await f.create(); const run = await workspace.fork({ actor: 'agent', ...request() }); const agent = workspace.agent(run.id);
        const plan = await agent.plan(program(), request()); const req = request();
        const link = fileIO.link;
        vi.spyOn(fileIO, 'link').mockImplementation(async (...args) => {
            if (String(args[1]).includes('/objects/')) throw Object.assign(new Error('full'), { code: 'ENOSPC' });
            return link(...args);
        });
        await expect(agent.apply(plan.id, req)).rejects.toThrow('full');
        expect((await agent.describe()).revision).toBe(run.head);
        await expect(workspace.receipt(req.requestId)).rejects.toMatchObject({ code: 'STRINGBASE_NOT_FOUND' });
        expect((await readdir(join(f.filepath, 'objects'))).some(name => name.endsWith('.tmp'))).toBe(false);
        vi.restoreAllMocks();
        await agent.apply(plan.id, req);
        expect((await agent.query(queryProgram)).documents[0]?.description).toBe('Improved description');
    });

    it('recovers unpublished snapshots and temporary objects after a known manifest failure', async () => {
        const workspace = await f.create(); const run = await workspace.fork({ actor: 'agent', ...request() }); const agent = workspace.agent(run.id);
        const plan = await agent.plan(program(), request()); const req = request();
        vi.spyOn(fileIO, 'rename').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
        await expect(agent.apply(plan.id, req)).rejects.toMatchObject({ code: 'STRINGBASE_IO' });
        expect(await readdir(join(f.filepath, 'objects'))).toHaveLength(2);
        await writeFile(join(f.filepath, 'objects', '.11111111-1111-1111-1111-111111111111.tmp'), 'partial');
        await workspace.close(); const reopened = await f.open();
        expect(await readdir(join(f.filepath, 'objects'))).toHaveLength(1);
        expect((await reopened.agent(run.id).describe()).revision).toBe(run.head);
        await reopened.agent(run.id).apply(plan.id, req);
    });

    it('blocks reads and queued writes after uncertain manifest publication, recovering one durable receipt', async () => {
        const workspace = await f.create(); const run = await workspace.fork({ actor: 'agent', ...request() }); const agent = workspace.agent(run.id);
        const plan = await agent.plan(program(), request()); const req = request(); const rename = fileIO.rename;
        vi.spyOn(fileIO, 'rename').mockImplementationOnce(async (...args) => { await rename(...args); throw new Error('lost acknowledgment'); });
        const applying = agent.apply(plan.id, req); const queued = workspace.describe();
        await expect(applying).rejects.toMatchObject({ code: 'STRINGBASE_COMMIT_UNCERTAIN' });
        await expect(queued).rejects.toMatchObject({ code: 'STRINGBASE_COMMIT_UNCERTAIN' });
        await expect(agent.query(queryProgram)).rejects.toMatchObject({ code: 'STRINGBASE_COMMIT_UNCERTAIN' });
        await workspace.close(); const reopened = await f.open();
        const committed = await reopened.agent(run.id).apply(plan.id, req);
        expect((await reopened.receipt(req.requestId)).result).toEqual(committed);
        expect((await reopened.agent(run.id).history()).total).toBe(1);
    });

    it('detects corrupt or missing referenced snapshots before cleaning other objects', async () => {
        const workspace = await f.create(); await workspace.close();
        const objects = join(f.filepath, 'objects'); const [name] = await readdir(objects); const filename = join(objects, name!); const bytes = await readFile(filename);
        const orphan = join(objects, 'f'.repeat(64) + '.deon'); await writeFile(orphan, 'orphan');
        await writeFile(filename, 'corrupt');
        await expect(f.open()).rejects.toMatchObject({ code: 'STRINGBASE_FILE_FORMAT' });
        expect(await readFile(orphan, 'utf8')).toBe('orphan');
        await rm(filename);
        await expect(f.open()).rejects.toMatchObject({ code: 'STRINGBASE_FILE_NOT_FOUND' });
        await writeFile(filename, bytes);
        await f.open(); expect(await readdir(objects)).toEqual([name]);
    });

    it('refuses snapshot symlinks, additional hard links, and a symlinked objects directory', async () => {
        const workspace = await f.create(); await workspace.close();
        const objects = join(f.filepath, 'objects'); const [name] = await readdir(objects); const filename = join(objects, name!); const bytes = await readFile(filename);
        const target = join(f.directory, 'outside.deon'); await writeFile(target, bytes); await rm(filename); await symlink(target, filename);
        await expect(f.open()).rejects.toBeInstanceOf(Error);
        await rm(filename); await link(target, filename);
        await expect(f.open()).rejects.toMatchObject({ code: 'STRINGBASE_FILE_FORMAT' });
        await rm(filename); await writeFile(filename, bytes);
        await rm(objects, { recursive: true }); await symlink(f.directory, objects);
        await expect(f.open()).rejects.toMatchObject({ code: 'STRINGBASE_FILE_FORMAT' });
    });

    it('validates manifest shape, policy digest, references and parent cycles on reopen', async () => {
        const workspace = await f.create(); await workspace.close(); const filename = join(f.filepath, 'manifest.deon');
        const original = await readFile(filename);
        const corrupt = async (modify: (value: Record<string, unknown>) => void) => {
            await writeFile(filename, original);
            const db = await Stringbase.open({ filepath: filename });
            const value = JSON.parse((await db.collection('workspace').get('manifest'))!.value as string) as Record<string, unknown>;
            modify(value); await db.collection('workspace').updateOne('manifest', { value: JSON.stringify(value) }); await db.close();
            await expect(f.open()).rejects.toMatchObject({ code: 'STRINGBASE_FILE_FORMAT' });
        };
        await corrupt(value => { value.version = 2; });
        await corrupt(value => { value.policyHash = 'wrong'; });
        await corrupt(value => { value.accepted = 'missing'; });
        await corrupt(value => { const revisions = value.revisions as Record<string, { id: string; parent: string }>; const revision = Object.values(revisions)[0]!; revision.parent = revision.id; });
        await corrupt(value => { const revision = Object.values(value.revisions as Record<string, { snapshot: string }>)[0]!; revision.snapshot = '../../escape'; });
        await writeFile(filename, original); await f.open();
    });

    it('enforces snapshot and workspace storage budgets without publishing changes', async () => {
        await expect(f.create({ maxSnapshotBytes: 1 })).rejects.toMatchObject({ code: 'STRINGBASE_LIMIT_EXCEEDED' });
        await rm(f.filepath, { recursive: true });
        await expect(f.create({ maxWorkspaceBytes: 1 })).rejects.toMatchObject({ code: 'STRINGBASE_LIMIT_EXCEEDED' });
        await rm(f.filepath, { recursive: true });
        const workspace = await f.create({ maxWorkspaceBytes: 3000 });
        const before = await workspace.describe();
        await expect(workspace.fork({ actor: 'a'.repeat(256), label: 'b'.repeat(256), ...request() })).rejects.toMatchObject({ code: 'STRINGBASE_LIMIT_EXCEEDED' });
        expect((await workspace.describe()).revision).toBe(before.revision);
    });

    it.each(['before', 'after'])('recovers after SIGKILL %s manifest replacement', async checkpoint => {
        const workspace = await f.create(); const run = await workspace.fork({ actor: 'agent', ...request() });
        const plan = await workspace.agent(run.id).plan(program(), request()); const req = request(); await workspace.close();
        const script = join(f.directory, 'crash.cjs');
        const module = new URL('../distribution/agent.cjs', import.meta.url).pathname;
        await writeFile(script, 'const fs=require("node:fs/promises"); const rename=fs.rename; const mode=process.argv[6];'
            + 'fs.rename=async function(...args){if(String(args[1]).endsWith("/manifest.deon")){if(mode==="after")await rename(...args);process.send("checkpoint");await new Promise(()=>{});}return rename(...args)};'
            + 'const {Workspace}=require(' + JSON.stringify(module) + ');'
            + 'Workspace.open({directory:process.argv[2]}).then(w=>w.agent(process.argv[3]).apply(process.argv[4],{requestId:process.argv[5]})).catch(e=>{process.send({error:String(e)});process.exitCode=1});');
        const child = fork(script, [f.filepath, run.id, plan.id, req.requestId, checkpoint], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        const exit = once(child, 'exit');
        try {
            expect((await once(child, 'message'))[0]).toBe('checkpoint');
        } finally { child.kill('SIGKILL'); await exit; }
        // This test knows the owning process exited. Production never steals stale locks.
        const lock = join(f.filepath, 'manifest.deon.stringbase-lock');
        expect(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')).pid).toBe(child.pid);
        await rm(lock, { recursive: true });
        const reopened = await f.open();
        expect((await reopened.agent(run.id).history()).total).toBe(checkpoint === 'after' ? 1 : 0);
        const applied = await reopened.agent(run.id).apply(plan.id, req);
        expect((await reopened.receipt(req.requestId)).result).toEqual(applied);
        expect((await reopened.agent(run.id).history()).total).toBe(1);
    });

    it('does not publish a partially written snapshot', async () => {
        const workspace = await f.create(); const run = await workspace.fork({ actor: 'agent', ...request() }); const agent = workspace.agent(run.id);
        const plan = await agent.plan(program(), request()); const open = fileIO.open;
        vi.spyOn(fileIO, 'open').mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (String(args[0]).includes('/objects/.') && args[1] === 'wx') {
                const original = handle.writeFile.bind(handle);
                vi.spyOn(handle, 'writeFile').mockImplementation(async bytes => { await original(Buffer.from(bytes as Uint8Array).subarray(0, 8)); throw Object.assign(new Error('full'), { code: 'ENOSPC' }); });
            }
            return handle;
        });
        await expect(agent.apply(plan.id, request())).rejects.toThrow('full');
        expect((await agent.describe()).revision).toBe(run.head);
        expect(await readdir(join(f.filepath, 'objects'))).toHaveLength(1);
    });

    it('treats directory sync failure after manifest replacement as uncertain', async () => {
        const workspace = await f.create(); const run = await workspace.fork({ actor: 'agent', ...request() }); const agent = workspace.agent(run.id);
        const plan = await agent.plan(program(), request()); const req = request(); const open = fileIO.open;
        const resolved = workspace.directory;
        vi.spyOn(fileIO, 'open').mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (args[0] === resolved && args[1] === 'r') vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('directory sync failed'));
            return handle;
        });
        await expect(agent.apply(plan.id, req)).rejects.toMatchObject({ code: 'STRINGBASE_COMMIT_UNCERTAIN' });
        await workspace.close(); vi.restoreAllMocks(); const reopened = await f.open();
        expect((await reopened.agent(run.id).apply(plan.id, req)).kind).toBe('apply');
    });
});
