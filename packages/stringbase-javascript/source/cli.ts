#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fromIR } from '@plurid/loque';
import { Stringbase } from './database';
import { applyBatch } from './batch';
import { StringbaseError, fail } from './errors';
import { fields } from './model';
import { parseValue } from './storage/codec';
import { parseLocator } from './locator';
import type { QueryOptions, ReadOptions } from './types';

declare const __STRINGBASE_VERSION__: string;
const help = `Usage: stringbase <command> <file.deon> [arguments] [options]

Commands:
  init                          create an empty database
  collections                   list collections
  create-collection <name>      create a collection
  drop-collection <name>        remove a collection and its documents
  get <collection> <id>         get a document
  query <locator>               find documents
  insert <collection>           insert a document or list of documents
  update <collection> <id>      update top-level fields
  replace <collection> <id>     replace all non-ID fields
  delete <collection> <id>      delete a document
  update-many <locator>         update selected documents
  delete-many <locator>         delete selected documents
  batch                         apply a version 1 JSON operations file
  validate                      validate without writing

Options:
  --data-file <payload.deon>     required by insert/update/replace/update-many
  --operations <batch.json>      required by batch
  --view <raw|typed>             query comparison view (results stay raw)
  --limit <n> --skip <n>         query pagination
  --sort <key|JSON-path-array>   query ordering; --descending reverses it
  --all                         explicitly target a complete collection in bulk commands
  --help --version
`;

async function payload(file: string | undefined): Promise<unknown> {
    if (!file) fail('INVALID_OPTIONS', '--data-file is required.');
    const bytes = await readFile(file);
    if (bytes.byteLength > 64 * 1024 * 1024) fail('LIMIT_EXCEEDED', 'Payload exceeds 64 MiB.');
    let source: string;
    try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch (cause) { throw new StringbaseError('INVALID_DATA', 'Payload is not valid UTF-8.', {}, cause); }
    return parseValue(source, file);
}

async function main(): Promise<number> {
    let db: Stringbase | undefined;
    try {
        const { positionals, values } = parseArgs({ allowPositionals: true, options: {
            help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
            'data-file': { type: 'string' }, operations: { type: 'string' }, view: { type: 'string' },
            limit: { type: 'string' }, skip: { type: 'string' }, sort: { type: 'string' },
            descending: { type: 'boolean' }, all: { type: 'boolean' },
        } });
        if (values.version) { process.stdout.write(`${__STRINGBASE_VERSION__}\n`); return 0; }
        if (values.help || !positionals.length) { process.stdout.write(help); return 0; }
        const [command, file, ...args] = positionals;
        const commands: Record<string, { args: number; flags: readonly string[]; write: boolean }> = {
            init: { args: 0, flags: [], write: true }, collections: { args: 0, flags: [], write: false },
            'create-collection': { args: 1, flags: [], write: true }, 'drop-collection': { args: 1, flags: [], write: true },
            get: { args: 2, flags: [], write: false },
            query: { args: 1, flags: ['view', 'limit', 'skip', 'sort', 'descending'], write: false },
            insert: { args: 1, flags: ['data-file'], write: true },
            update: { args: 2, flags: ['data-file'], write: true }, replace: { args: 2, flags: ['data-file'], write: true },
            delete: { args: 2, flags: [], write: true },
            'update-many': { args: 1, flags: ['data-file', 'view', 'all'], write: true },
            'delete-many': { args: 1, flags: ['view', 'all'], write: true },
            batch: { args: 0, flags: ['operations'], write: true }, validate: { args: 0, flags: [], write: false },
        };
        if (!command || !Object.hasOwn(commands, command) || !file) fail('INVALID_OPTIONS', 'Expected a known command and database filepath.');
        const spec = commands[command]!;
        if (args.length !== spec.args || Object.keys(values).some(key => !spec.flags.includes(key))) fail('INVALID_OPTIONS', 'Unexpected arguments or options for this command.');
        const view: QueryOptions = values.view === undefined ? {} : { view: values.view as 'raw' | 'typed' };
        db = command === 'init' ? await Stringbase.create({ filepath: file }) : await Stringbase.open({ filepath: file, mode: spec.write ? 'readwrite' : 'readonly' });
        const collection = args[0] ? db.collection(command === 'query' || command.endsWith('-many') ? parseLocator(args[0], view).collection : args[0]) : undefined;
        let result: unknown;
        switch (command) {
            case 'init': result = { filepath: db.filepath }; break;
            case 'collections': result = await db.listCollections(); break;
            case 'create-collection': await db.createCollection(args[0]!); result = { collection: args[0] }; break;
            case 'drop-collection': await db.dropCollection(args[0]!); result = { collection: args[0] }; break;
            case 'get': {
                result = await collection!.get(args[1]!);
                if (result === undefined) { process.stderr.write('Document not found.\n'); return 3; }
                break;
            }
            case 'query': {
                const options: ReadOptions = { ...view };
                const numeric = (value: string): number => {
                    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail('INVALID_OPTIONS', 'Pagination requires nonnegative safe integers.');
                    return Number(value);
                };
                const sorting = values.sort;
                const path: unknown = sorting?.startsWith('[') ? JSON.parse(sorting) : sorting === undefined ? undefined : [sorting];
                const configured: ReadOptions = {
                    ...options,
                    ...(values.limit === undefined ? {} : { limit: numeric(values.limit) }),
                    ...(values.skip === undefined ? {} : { skip: numeric(values.skip) }),
                    ...(path === undefined ? {} : { sort: { path: path as readonly (string | number)[], direction: values.descending ? 'desc' : 'asc' } }),
                };
                if (values.descending && sorting === undefined) fail('INVALID_OPTIONS', '--descending requires --sort.');
                result = await db.read(args[0]!, configured); break;
            }
            case 'insert': {
                const input = await payload(values['data-file']);
                result = Array.isArray(input) ? await collection!.insertMany(input.map(fields)) : await collection!.insertOne(fields(input));
                break;
            }
            case 'update': result = await collection!.updateOne(args[1]!, fields(await payload(values['data-file']))); break;
            case 'replace': result = await collection!.replaceOne(args[1]!, fields(await payload(values['data-file']))); break;
            case 'delete': result = await collection!.deleteOne(args[1]!); break;
            case 'update-many': case 'delete-many': {
                const parsed = parseLocator(args[0]!, view);
                if ((!parsed.query.steps.length && !values.all) || (parsed.query.steps.length && values.all)) fail('INVALID_OPTIONS', 'Use a filtered locator or --all with a collection name.');
                const target = fromIR(parsed.query);
                result = command === 'delete-many' ? await collection!.deleteMany(target, view)
                    : await collection!.updateMany(target, fields(await payload(values['data-file'])), view);
                break;
            }
            case 'batch': {
                if (!values.operations) fail('INVALID_OPTIONS', '--operations is required.');
                const bytes = await readFile(values.operations);
                if (bytes.byteLength > 64 * 1024 * 1024) fail('LIMIT_EXCEEDED', 'Batch payload exceeds 64 MiB.');
                result = await applyBatch(db, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); break;
            }
            case 'validate': {
                const names = await db.listCollections();
                let documents = 0;
                for (const name of names) documents += await db.collection(name).count();
                result = { valid: true, collections: names.length, documents }; break;
            }
        }
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
    } catch (cause) {
        if (cause instanceof StringbaseError) {
            process.stderr.write(`${cause.code}: ${cause.message}\n`);
            return ['INVALID_OPTIONS', 'INVALID_DATA', 'INVALID_QUERY', 'INVALID_LOCATOR', 'FILE_FORMAT', 'DUPLICATE_ID', 'LIMIT_EXCEEDED', 'BATCH_FAILED']
                .some(code => cause.code === `STRINGBASE_${code}`) ? 2 : 1;
        }
        process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
        return cause instanceof SyntaxError || (cause instanceof TypeError && 'code' in cause) ? 2 : 1;
    } finally { if (db) await db.close(); }
}

void main().then(code => { process.exitCode = code; }).catch(cause => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
});
