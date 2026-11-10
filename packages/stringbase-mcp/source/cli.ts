#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createStringbaseServer } from './index';

async function main(): Promise<void> {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { actor: { type: 'string' }, run: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' } } });
    if (values.help) { process.stdout.write('Usage: stringbase-mcp <workspace-directory> --actor <host-selected-name> [--run <granted-run-id>]\n'); return; }
    if (positionals.length !== 1 || !values.actor) throw new Error('Expected a workspace directory and --actor.');
    const application = await createStringbaseServer({ directory: positionals[0]!, actor: values.actor, ...(values.run ? { runIds: values.run } : {}) });
    let stopping: Promise<void> | undefined;
    const shutdown = () => {
        stopping ??= application.close().then(() => { process.exitCode = 0; }, error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
    };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    // The SDK's stdio transport listens to data/error, but does not close on EOF.
    process.stdin.once('end', shutdown);
    try { await application.server.connect(new StdioServerTransport()); }
    catch (cause) { await application.close(); throw cause; }
}
main().catch(cause => { process.stderr.write((cause instanceof Error ? cause.message : String(cause)) + '\n'); process.exitCode = 1; });
