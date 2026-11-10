import { constants } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileStore, fileIO } from '../storage/file';
import { encode, decode } from '../storage/codec';
import { databaseData } from '../model';
import { fail, hasCode, io, StringbaseError } from '../errors';
import type { DatabaseData } from '../types';
import type { Manifest } from './types';
import { byteHash, canonical } from './util';

const manifestData = (manifest: Manifest): DatabaseData => databaseData({ workspace: [{ id: 'manifest', value: canonical(manifest) }] });
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

/** All authoritative state is published by the existing atomic FileStore. */
export class WorkspaceStore {
    private file!: FileStore;
    private cache = new Map<string, { data: DatabaseData; bytes: number }>();
    private constructor(readonly directory: string, readonly readonly: boolean) {}
    get objects(): string { return path.join(this.directory, 'objects'); }

    static async create(directory: string, data: DatabaseData, build: (snapshot: string) => Manifest): Promise<{ store: WorkspaceStore; manifest: Manifest }> {
        const absolute = path.resolve(directory);
        const parent = await realpath(path.dirname(absolute));
        const resolved = path.join(parent, path.basename(absolute));
        try { await fileIO.mkdir(resolved, { mode: 0o700 }); }
        catch (cause) { if (hasCode(cause, 'EEXIST')) fail('FILE_EXISTS', 'Workspace directory already exists.'); throw io(cause, resolved); }
        const store = new WorkspaceStore(resolved, false);
        await fileIO.mkdir(store.objects, { mode: 0o700 });
        // Build once to obtain limits before writing the initial immutable snapshot.
        const draft = build('');
        const snapshot = await store.writeSnapshot(data, draft);
        const manifest = build(snapshot);
        await store.checkQuota(manifest);
        const opened = await FileStore.open({ filepath: path.join(resolved, 'manifest.deon') }, true, manifestData(manifest));
        store.file = opened.store;
        try {
            // Persist the workspace's directory entry in its parent before acknowledging creation.
            const handle = await fileIO.open(parent, 'r');
            try { await handle.sync(); } finally { await handle.close(); }
        } catch (cause) {
            await store.close();
            throw new StringbaseError('COMMIT_UNCERTAIN', 'Workspace was published but its parent directory could not be synced; reopen to inspect it.', { directory: resolved }, cause);
        }
        return { store, manifest };
    }

    static async open(directory: string, readonly: boolean): Promise<{ store: WorkspaceStore; value: unknown }> {
        const resolved = await realpath(directory);
        const store = new WorkspaceStore(resolved, readonly);
        const info = await lstat(store.objects);
        if (!info.isDirectory() || info.isSymbolicLink()) fail('FILE_FORMAT', 'Workspace objects must be a real directory.');
        const opened = await FileStore.open({ filepath: path.join(resolved, 'manifest.deon'), mode: readonly ? 'readonly' : 'readwrite' }, false);
        store.file = opened.store;
        try {
            const rows = opened.data.workspace;
            if (Object.keys(opened.data).length !== 1 || rows?.length !== 1 || rows[0]?.id !== 'manifest' || typeof rows[0].value !== 'string') fail('FILE_FORMAT', 'Invalid workspace manifest.');
            return { store, value: JSON.parse(rows[0].value) as unknown };
        } catch (cause) { await store.close(); throw cause; }
    }

    private filename(hash: string): string {
        if (!/^[a-f0-9]{64}$/.test(hash)) fail('FILE_FORMAT', 'Invalid snapshot reference.');
        return path.join(this.objects, hash + '.deon');
    }

    private async readBytes(filename: string, maximum: number): Promise<Buffer> {
        const handle = await fileIO.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const info = await handle.stat();
            if (!info.isFile() || info.nlink > 1) fail('FILE_FORMAT', 'Snapshot must be a regular file without additional hard links.');
            if (info.size > maximum) fail('LIMIT_EXCEEDED', 'Snapshot exceeds maxSnapshotBytes.');
            const chunks: Buffer[] = []; let length = 0;
            while (true) {
                const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximum - length + 1));
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
                if (!bytesRead) break;
                length += bytesRead;
                if (length > maximum) fail('LIMIT_EXCEEDED', 'Snapshot exceeds maxSnapshotBytes.');
                chunks.push(buffer.subarray(0, bytesRead));
            }
            return Buffer.concat(chunks, length);
        } finally { await handle.close(); }
    }

    async readSnapshot(hash: string, maximum: number): Promise<DatabaseData> {
        const filename = this.filename(hash);
        const cached = this.cache.get(hash);
        if (cached) { this.cache.delete(hash); this.cache.set(hash, cached); return cached.data; }
        let bytes: Buffer;
        try { bytes = await this.readBytes(filename, maximum); }
        catch (cause) { throw io(cause, filename); }
        if (byteHash(bytes) !== hash) fail('FILE_FORMAT', 'Snapshot digest does not match its reference.');
        const data = decode(bytes, filename, maximum);
        this.remember(hash, data, bytes.length);
        return data;
    }

    private remember(hash: string, data: DatabaseData, bytes: number): void {
        // Two immutable snapshots, bounded by 8 MiB of encoded data. This is not a RAM estimate.
        if (bytes > 8 * 1024 * 1024) return;
        this.cache.delete(hash); this.cache.set(hash, { data, bytes });
        while (this.cache.size > 2 || [...this.cache.values()].reduce((total, entry) => total + entry.bytes, 0) > 8 * 1024 * 1024) this.cache.delete(this.cache.keys().next().value!);
    }

    async writeSnapshot(data: DatabaseData, manifest: Manifest): Promise<string> {
        const bytes = encode(data, manifest.maxSnapshotBytes);
        const hash = byteHash(bytes); const filename = this.filename(hash);
        try {
            const existing = await this.readBytes(filename, manifest.maxSnapshotBytes);
            if (!existing.equals(bytes)) fail('FILE_FORMAT', 'Existing immutable snapshot is corrupt.');
            this.remember(hash, data, bytes.length); return hash;
        } catch (cause) { if (!hasCode(cause, 'ENOENT')) throw cause; }
        await this.checkQuota(manifest, bytes.length);
        const temporary = path.join(this.objects, '.' + randomUUID() + '.tmp');
        try {
            const handle = await fileIO.open(temporary, 'wx', 0o600);
            try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
            await fileIO.link(temporary, filename);
            await fileIO.unlink(temporary);
            const directory = await fileIO.open(this.objects, 'r');
            try { await directory.sync(); } finally { await directory.close(); }
        } finally { try { await fileIO.unlink(temporary); } catch { /* Only this random pathname is owned here. */ } }
        this.remember(hash, data, bytes.length); return hash;
    }

    async checkQuota(manifest: Manifest, additional = 0): Promise<void> {
        let size = encode(manifestData(manifest), MAX_MANIFEST_BYTES).length + additional;
        for (const name of await readdir(this.objects)) size += (await lstat(path.join(this.objects, name))).size;
        if (size > manifest.maxWorkspaceBytes) fail('LIMIT_EXCEEDED', 'Workspace exceeds maxWorkspaceBytes. Export/archive it or use a larger configured budget.');
    }

    async commit(manifest: Manifest): Promise<void> {
        await this.checkQuota(manifest);
        await this.file.commit(manifestData(manifest));
    }

    async recover(manifest: Manifest): Promise<void> {
        const referenced = new Set(Object.values(manifest.revisions).map(revision => revision.snapshot));
        // Verify every referenced snapshot before removing any unpublished object.
        for (const hash of referenced) await this.readSnapshot(hash, manifest.maxSnapshotBytes);
        if (this.readonly) return;
        for (const name of await readdir(this.objects)) {
            const orphan = /^[a-f0-9]{64}\.deon$/.test(name) && !referenced.has(name.slice(0, -5));
            const temporary = /^\.[a-f0-9-]{36}\.tmp$/.test(name);
            if (orphan || temporary) await fileIO.unlink(path.join(this.objects, name));
        }
        await this.checkQuota(manifest);
    }
    close(): Promise<void> { this.cache.clear(); return this.file.close(); }
}
