import { afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Stringbase from '../source';

export function fixture() {
    let directory: string;
    let filepath: string;
    const handles: Stringbase[] = [];
    beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'stringbase-test-'))); filepath = join(directory, 'data.deon'); });
    afterEach(async () => {
        vi.restoreAllMocks();
        await Promise.allSettled(handles.map(db => db.close()));
        await rm(directory, { recursive: true, force: true });
    });
    return {
        get directory() { return directory; }, get filepath() { return filepath; },
        track(db: Stringbase) { handles.push(db); return db; },
        async create() { const db = await Stringbase.create({ filepath }); handles.push(db); await db.createCollection('records'); return db; },
        async open(mode: 'readwrite' | 'readonly' = 'readwrite') { const db = await Stringbase.open({ filepath, mode }); handles.push(db); return db; },
    };
}
