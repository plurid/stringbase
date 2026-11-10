import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const core = join(root, 'packages/stringbase-javascript'); const mcp = join(root, 'packages/stringbase-mcp');
const temporary = await mkdtemp(join(tmpdir(), 'stringbase-mcp-package-'));
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
try {
    const coreTarball = join(temporary, 'stringbase.tgz'); const mcpTarball = join(temporary, 'mcp.tgz');
    // Verification already built both packages. Avoid redundant prepack builds.
    run('pnpm', ['pack', '--config.ignore-scripts=true', '--out', coreTarball], core);
    run('pnpm', ['pack', '--config.ignore-scripts=true', '--out', mcpTarball], mcp);
    const packed = JSON.parse(run('tar', ['-xOf', mcpTarball, 'package/package.json']));
    const manifest = JSON.parse(await readFile(join(core, 'package.json'), 'utf8'));
    assert.equal(packed.dependencies['@plurid/stringbase'], manifest.version);
    const entries = run('tar', ['-tzf', mcpTarball]).trim().split('\n');
    assert.ok(entries.every(name => /^package\/(distribution\/|package\.json$|README\.md$|LICENSE$)/.test(name)));
    run('pnpm', ['exec', 'publint', mcpTarball, '--strict'], core);
    const consumer = join(temporary, 'consumer'); await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'mcp-consumer', private: true, type: 'module', dependencies: { '@plurid/stringbase': 'file:' + coreTarball, '@plurid/stringbase-mcp': 'file:' + mcpTarball } }));
    await writeFile(join(consumer, 'pnpm-workspace.yaml'), 'packages: []\noverrides:\n  "@plurid/stringbase": ' + JSON.stringify('file:' + coreTarball) + '\n');
    run('pnpm', ['install', '--prod', '--no-lockfile'], consumer);
    await writeFile(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {Workspace} from '@plurid/stringbase/agent';
import {createStringbaseServer} from '@plurid/stringbase-mcp';
const requireMcp=createRequire(import.meta.resolve('@plurid/stringbase-mcp'));
const {Client}=requireMcp('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=requireMcp('@modelcontextprotocol/sdk/client/stdio.js');
assert.equal(typeof createStringbaseServer,'function');
const workspace=await Workspace.create({directory:'./workspace',data:{products:[{id:'1',description:'old'}]},policy:{version:'1',read:['/products/*'],write:['/products/*/description'],schema:{products:{description:{kind:'string'}}}},sourceRevision:'source',actor:'host'});
await workspace.close();
const binary=fileURLToPath(new URL('./cli.mjs',import.meta.resolve('@plurid/stringbase-mcp')));
const transport=new StdioClientTransport({command:process.execPath,args:[binary,'./workspace','--actor','installed-agent'],stderr:'pipe'});
const client=new Client({name:'packed-consumer',version:'1'});
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length,9);
  const fork=await client.callTool({name:'stringbase_fork',arguments:{requestId:'fork'}});
  assert.equal(fork.isError,false);
  const read=await client.callTool({name:'stringbase_query',arguments:{runId:fork.structuredContent.result.id,program:{version:1,collection:'products',query:{version:1,steps:[]}}}});
  assert.equal(read.structuredContent.result.documents[0].description,'old');
} finally { await client.close(); }
const reopened=await Workspace.open({directory:'./workspace'});await reopened.close();
`);
    run(process.execPath, [join(consumer, 'smoke.mjs')], consumer);
    assert.match(run(join(consumer, 'node_modules/.bin/stringbase-mcp'), ['--help'], consumer), /host-selected/);
    await writeFile(join(consumer, 'types.mts'), "import {createStringbaseServer,type ServerOptions} from '@plurid/stringbase-mcp'; export const options:ServerOptions={directory:'workspace',actor:'agent'}; export const example=()=>createStringbaseServer(options);\n");
    await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2024', 'DOM'], module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, types: ['node'], typeRoots: [join(core, 'node_modules/@types')] }, files: ['types.mts'] }));
    run(process.execPath, [join(core, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')], consumer);
    console.log('MCP package passed: isolated production install, actual stdio client, CLI, lock release, public types, publint.');
} catch (error) {
    if (error && typeof error === 'object' && 'stderr' in error) console.error(String(error.stderr));
    throw error;
} finally { await rm(temporary, { recursive: true, force: true }); }
