import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { decode, encode } from './codec';
import { DEFAULT_MAX_BYTES } from '../model';
import { fail, hasCode, io, StringbaseError } from '../errors';
import type { DatabaseData, StringbaseOptions } from '../types';

/** Internal fault-injection boundary; not part of the package exports. */
export const fileIO = {
    open: fs.open, mkdir: fs.mkdir, readFile: fs.readFile, writeFile: fs.writeFile,
    rename: fs.rename, link: fs.link, unlink: fs.unlink, rm: fs.rm, realpath: fs.realpath,
};
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export class FileStore {
    private baseline: string | undefined;
    private token: string | undefined;
    private released = false;
    readonly lockpath: string;

    private constructor(readonly filepath: string, readonly readonly: boolean, readonly maxBytes: number) {
        this.lockpath = `${filepath}.stringbase-lock`;
    }

    static async open(options: StringbaseOptions, create: boolean, initialData?: DatabaseData): Promise<{ store: FileStore; data: DatabaseData }> {
        if (!options || typeof options !== 'object' || typeof options.filepath !== 'string' || !options.filepath.trim()
            || Object.keys(options).some(key => !['filepath', 'mode', 'maxFileBytes'].includes(key))
            || (options.mode !== undefined && options.mode !== 'readonly' && options.mode !== 'readwrite')
            || (create && options.mode === 'readonly')) fail('INVALID_OPTIONS', 'Expected a filepath, optional mode, and maxFileBytes.');
        const max = options.maxFileBytes ?? DEFAULT_MAX_BYTES;
        if (!Number.isSafeInteger(max) || max <= 0) fail('INVALID_OPTIONS', 'maxFileBytes must be a positive safe integer.');
        if (process.platform !== 'darwin' && process.platform !== 'linux' && options.mode !== 'readonly') fail('INVALID_OPTIONS', 'Writer support currently requires macOS or Linux.');
        const absolute = path.resolve(options.filepath);
        let resolved: string;
        try { resolved = path.join(await fileIO.realpath(path.dirname(absolute)), path.basename(absolute)); }
        catch (cause) { throw io(cause, absolute); }
        const store = new FileStore(resolved, options.mode === 'readonly', max);
        try {
            if (!store.readonly) await store.acquire();
            if (create) {
                try { await store.readBytes(); fail('FILE_EXISTS', `Database '${resolved}' already exists.`, { filepath: resolved }); }
                catch (cause) { if (!hasCode(cause, 'ENOENT')) throw cause; }
                const data = initialData ?? Object.freeze(Object.create(null)) as DatabaseData;
                await store.commit(data, true);
                return { store, data };
            }
            const bytes = await store.readBytes();
            const data = decode(bytes, resolved, max);
            store.baseline = digest(bytes);
            return { store, data };
        } catch (cause) {
            try { await store.close(); } catch { /* Preserve the original open failure. */ }
            throw io(cause, resolved);
        }
    }

    private async acquire(): Promise<void> {
        const token = randomUUID();
        try { await fileIO.mkdir(this.lockpath, { mode: 0o700 }); }
        catch (cause) {
            if (hasCode(cause, 'EEXIST')) {
                let owner: unknown;
                try { owner = JSON.parse(await fileIO.readFile(path.join(this.lockpath, 'owner.json'), 'utf8')); } catch { owner = undefined; }
                throw new StringbaseError('LOCKED', `Database '${this.filepath}' has a writer.`, { filepath: this.filepath, lockpath: this.lockpath, owner }, cause);
            }
            throw cause;
        }
        try {
            await fileIO.writeFile(path.join(this.lockpath, 'owner.json'), JSON.stringify({ token, pid: process.pid, host: hostname(), createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
            this.token = token;
        } catch (cause) {
            await fileIO.rm(this.lockpath, { recursive: true, force: true });
            throw cause;
        }
    }

    private async assertOwner(): Promise<void> {
        if (!this.token || this.released) fail('CONFLICT', 'Writer ownership is no longer held.', { filepath: this.filepath });
        try {
            const owner: unknown = JSON.parse(await fileIO.readFile(path.join(this.lockpath, 'owner.json'), 'utf8'));
            if (!owner || typeof owner !== 'object' || !('token' in owner) || owner.token !== this.token) throw new Error('Ownership changed');
        } catch (cause) { throw new StringbaseError('CONFLICT', 'Writer ownership changed.', { lockpath: this.lockpath }, cause); }
    }

    private async readBytes(): Promise<Buffer> {
        const handle = await fileIO.open(this.filepath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const info = await handle.stat();
            if (!info.isFile() || info.nlink > 1) fail('INVALID_OPTIONS', 'Database must be a regular file without additional hard links.', { filepath: this.filepath });
            if (info.size > this.maxBytes) fail('LIMIT_EXCEEDED', 'Database exceeds maxFileBytes.');
            const chunks: Buffer[] = [];
            let length = 0;
            while (true) {
                const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, this.maxBytes - length + 1));
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
                if (!bytesRead) break;
                length += bytesRead;
                if (length > this.maxBytes) fail('LIMIT_EXCEEDED', 'Database exceeds maxFileBytes.');
                chunks.push(buffer.subarray(0, bytesRead));
            }
            return Buffer.concat(chunks, length);
        } finally { await handle.close(); }
    }

    private async fresh(create: boolean): Promise<void> {
        await this.assertOwner();
        try {
            const bytes = await this.readBytes();
            if (create) fail('FILE_EXISTS', 'Database appeared during creation.', { filepath: this.filepath });
            if (digest(bytes) !== this.baseline) fail('CONFLICT', 'Database changed on disk; reload before writing.', { filepath: this.filepath });
        } catch (cause) {
            if (create && hasCode(cause, 'ENOENT')) return;
            if (!create && hasCode(cause, 'ENOENT')) throw new StringbaseError('CONFLICT', 'Database was removed from disk.', { filepath: this.filepath }, cause);
            throw cause;
        }
    }

    async commit(data: DatabaseData, create = false): Promise<void> {
        if (this.readonly) fail('READ_ONLY', 'Database was opened read-only.');
        const bytes = encode(data, this.maxBytes);
        const temporary = path.join(path.dirname(this.filepath), `.${path.basename(this.filepath)}.stringbase-${randomUUID()}.tmp`);
        let publicationAttempted = false;
        let published = false;
        try {
            await this.fresh(create);
            const handle = await fileIO.open(temporary, 'wx', 0o600);
            try {
                if (!create) {
                    const original = await fileIO.open(this.filepath, constants.O_RDONLY | constants.O_NOFOLLOW);
                    try { await handle.chmod((await original.stat()).mode & 0o777); }
                    finally { await original.close(); }
                }
                await handle.writeFile(bytes);
                await handle.sync();
            } finally { await handle.close(); }
            await this.fresh(create);
            publicationAttempted = true;
            if (create) {
                await fileIO.link(temporary, this.filepath);
                published = true;
                await fileIO.unlink(temporary);
            } else {
                await fileIO.rename(temporary, this.filepath);
                published = true;
            }
            const directory = await fileIO.open(path.dirname(this.filepath), 'r');
            try { await directory.sync(); } finally { await directory.close(); }
            this.baseline = digest(bytes);
        } catch (cause) {
            // A publication call can succeed before an adapter reports failure. Only
            // specified pre-operation filesystem errors prove the old state survived.
            const knownUnchanged = ['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'EXDEV', 'ENOSPC', 'EROFS', 'EISDIR', 'ENOTDIR', 'EBUSY', 'EINVAL']
                .some(code => hasCode(cause, code));
            if (published || (publicationAttempted && !knownUnchanged)) {
                throw new StringbaseError('COMMIT_UNCERTAIN', 'Replacement may have committed; close and reopen the database.', { filepath: this.filepath, temporary }, cause);
            }
            if (create && hasCode(cause, 'EEXIST')) throw new StringbaseError('FILE_EXISTS', 'Database already exists.', { filepath: this.filepath }, cause);
            throw io(cause, this.filepath);
        } finally {
            // This operation owns exactly this random temporary pathname.
            try { await fileIO.unlink(temporary); } catch { /* Target outcome is authoritative. */ }
        }
    }

    async reload(): Promise<DatabaseData> {
        try {
            if (!this.readonly) await this.assertOwner();
            const bytes = await this.readBytes();
            const data = decode(bytes, this.filepath, this.maxBytes);
            this.baseline = digest(bytes);
            return data;
        } catch (cause) { throw io(cause, this.filepath); }
    }

    async close(): Promise<void> {
        if (this.released || !this.token) return;
        await this.assertOwner();
        try { await fileIO.rm(this.lockpath, { recursive: true }); this.released = true; }
        catch (cause) { throw io(cause, this.lockpath); }
    }
}
