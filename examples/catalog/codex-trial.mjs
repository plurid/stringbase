import { parseArgs } from 'node:util';
import { runCodexTrial } from './codex-trial-lib.mjs';

try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' }, model: { type: 'string' }, timeout: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
    if (values.help) process.stdout.write('Usage: pnpm trial:codex [--output <new-directory>] [--model <model>] [--timeout <seconds>]\nUses your existing Codex sign-in for a live model run. Ends at a proposal for human review.\n');
    else {
        if (positionals.length || (values.timeout !== undefined && !/^\d+$/.test(values.timeout))) throw new Error('Unexpected arguments or invalid timeout.');
        const report = await runCodexTrial({ ...(values.output ? { outputDirectory: values.output } : {}), ...(values.model ? { model: values.model } : {}), ...(values.timeout ? { timeoutMs: Number(values.timeout) * 1000 } : {}) });
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        process.exitCode = report.status === 'ready_for_review' ? 0 : 1;
    }
} catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
