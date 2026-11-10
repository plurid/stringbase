import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeonPure } from '@plurid/deon/pure';
import { validateBatch } from '../distribution/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const readme = await readFile(resolve(root, 'README.md'), 'utf8');
assert.equal(readme, await readFile(resolve(root, '../../README.md'), 'utf8'), 'Root and package documentation differ');
const temporary = await mkdtemp(join(tmpdir(), 'stringbase-docs-'));
try {
    await mkdir(join(temporary, 'node_modules/@plurid'), { recursive: true });
    await symlink(root, join(temporary, 'node_modules/@plurid/stringbase'), 'dir');
    let checked = 0;
    for (const match of readme.matchAll(/```(javascript|deon)\n([\s\S]*?)```/g)) {
        if (match[1] === 'deon') new DeonPure().parseSynchronous(match[2]);
        else {
            const filename = join(temporary, `example-${checked}.mjs`);
            await writeFile(filename, match[2]);
            execFileSync(process.execPath, [filename], { cwd: temporary, stdio: 'pipe' });
        }
        checked++;
    }
    assert.ok(checked >= 2, 'Expected executable examples and a Deon example');
    const agentGuide = await readFile(resolve(root, '../../docs/agent-workspaces.md'), 'utf8');
    for (const match of agentGuide.matchAll(/```javascript\n([\s\S]*?)```/g)) {
        const filename = join(temporary, `agent-example-${checked}.mjs`);
        await writeFile(filename, match[1]);
        execFileSync(process.execPath, [filename], { cwd: temporary, stdio: 'pipe' });
        checked++;
    }
    const batch = await readFile(resolve(root, '../../docs/batch-format.md'), 'utf8');
    for (const match of batch.matchAll(/```json\n([\s\S]*?)```/g)) validateBatch(JSON.parse(match[1]));
    console.log(`Documentation checks passed (${checked} README examples and batch payloads).`);
} finally { await rm(temporary, { recursive: true, force: true }); }
