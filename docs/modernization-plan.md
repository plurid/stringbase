# Stringbase modernization plan

Status: implemented feature baseline for 0.0.0-1; implementation decisions and
dependency bundling adjustments are recorded in dependency-compatibility.md.
Date: 2026-11-10.

This document describes the intended next version, not the behavior of the
current prototype. It is the plan to implement before calling the modernization
complete. The proposed API spellings below become fixed in milestone 1, alongside
executable contract fixtures.

## 1. Product contract

Stringbase is an embedded document database whose durable representation is one
human-readable Deon file. A JavaScript or TypeScript application opens the file,
queries named collections, and commits changes through a small asynchronous API.

The first version provides:

- Explicit creation, opening, read-only access, reload, and close.
- Collections of documents with stable string IDs.
- Insert, find, update, replace, and delete, including bulk operations.
- Structured queries and a specified locator shorthand.
- Immediate persistence and atomic batches across collections.
- One cooperating writer per file, with predictable failures and recovery.
- A CLI exposing the same database operations.
- Typed package entry points, reproducible tooling, CI, and integration tests.

The operating model is a database that fits in memory, queried by scanning its
collections and committed by replacing the complete file. Each successful
mutation is persisted before its promise resolves. A batch is the way to group
several changes into one commit.

Indexes, append-only journals, delayed writes, alternate cache modes, live file
watching, subscriptions, cross-file transactions, remote access, replication,
probabilistic queries, and additional language implementations are later work.
They require separate contracts and evidence that the simpler model is insufficient.

## 2. Starting point and dependency boundaries

The current Stringbase package is version `0.0.0-0`. Its
[implementation](https://github.com/plurid/stringbase/blob/a5e6a9722966392cb605141945a75f5c5d5b73e5/packages/stringbase-javascript/source/objects/Stringbase/index.ts)
delegates `read` and `write` to `loque.extract` and `loque.update`. Initialization, deletion,
file recording, and the declared cache strategies are unfinished. The local
locator/extractor implementations are scaffolding, and focused tests currently
hide most of the intended scenarios.

The neighboring Deon JavaScript checkout is version `0.0.0-11`. It supplies
syntax parsing, pure evaluation, readable stringification, a conservative typer,
and coded diagnostics. Stringbase should use these implementations, without
copying Deon's scanner, evaluator, or stringifier.

The neighboring Loque checkout has changed its API substantially even though its
manifest still says `0.0.0-0`. It now provides immutable `snapshot` values, `query`
builders, predicates, selections, and mutation plans. Its tests explicitly assert
that the old `extract` export is absent. A version-number update alone cannot
modernize Stringbase's use of Loque.

Assign responsibilities as follows:

| Component | Owns |
| --- | --- |
| Deon | Notation, evaluation, serialization, diagnostics, optional value typing |
| Loque | Deterministic selection, predicate evaluation, stable ordering, mutation planning |
| Stringbase | Database shape, document identity, lifecycle, commits, locking, batches, CLI |

Published availability of the required dependency APIs is **unverified**. The
registry lookup attempted during planning failed with `ENOTFOUND`. Milestone 1
must identify installable releases, or test isolated local package tarballs and
record the release dependency. Do not assume that the unchanged Loque version
contains its new API on the registry. Do not commit absolute paths or a dependency
on an unpublished neighboring checkout.

No changes to the Deon or Loque repositories are part of this plan. Any necessary
upstream release is a separate release task; Stringbase integration can be tested
with tarballs built from temporary copies of those checkouts.

## 3. File and value model

The root is a map from collection names to lists of document maps:

```deon
{
    records [
        {
            id 123
            name Ada
            active true
            age 37
            profile {
                city London
            }
        }
    ]
    events []
}
```

Here `id`, `active`, and `age` hold strings. The file contains no hidden metadata
or storage envelope. This is the Stringbase v1 file profile; an incompatible
future layout requires an explicit migration.

### Values and validation

- A stored value is a string, a list of stored values, or a map of stored values.
- A document is a map with its own nonempty string `id` property.
- Collection names match `[A-Za-z_][A-Za-z0-9_-]*`; collection names are case-sensitive.
- Document IDs are case-sensitive and unique within their collection. They are
  compared exactly, without trimming, numeric conversion, or Unicode normalization.
- An insert without an ID receives a UUID from `node:crypto.randomUUID`. Empty or
  duplicate supplied IDs fail the entire operation. Replacements preserve the
  selected document's ID; updates cannot change or remove it.
- New documents append to collection order. Updating or replacing a document keeps
  its position; deleting documents preserves the relative order of the survivors.
- Nested maps and lists are supported. Their members do not become independently
  addressable database documents merely because they contain an `id` field.
- SDK writes reject numbers, booleans, null, undefined, sparse arrays, cycles,
  accessors, and non-plain objects. No silent coercion to strings or empty values.
  Validation must not execute an accessor while inspecting an input.
- Return immutable copies/snapshots. Mutating an input or a previously returned
  object cannot change database state or bypass persistence.
- Validate own properties throughout, including names such as `__proto__` and
  `constructor`; inherited properties are never database fields.

Use Deon's documented depth and expansion limits. Add a configurable
`maxFileBytes`, initially 64 MiB, enforced on input bytes and the serialized next
state before replacement. This is a file-size bound, not a promise about memory
consumption. Measure peak memory and commit cost before revising the default.

### Authored Deon and normalization

Opening and reading do not rewrite the source. On the first actual data change,
Stringbase writes the evaluated root using readable inline Deon, four spaces,
LF, and one trailing newline. Collection array order is retained. Map field order
is presentation information, not a database ordering guarantee.

Comments, internal leaflinks, spreads, structures, and entity calls may be used
in a self-contained source file. Their evaluated values are stored on commit;
their original source arrangement is not retained. This behavior must be stated
next to the first write example in the README.

Imports, injections, and environment references are outside the writable database
profile and are rejected explicitly, including references inside interpolation.
Use syntax inspection and Deon's pure entry point with filesystem/network denied,
an empty environment, no supplied external resources, and no implicit datasign
reads. Do not use convenience file readers that swallow parse errors or grant
nested filesystem access.

## 4. SDK surface and operation semantics

The main entry point exposes `Stringbase` as both a named export and the default
export, plus public types and `StringbaseError`. The CLI has its own executable
entry point; importing the library does not load a command parser or inspect argv.

```ts
import Stringbase from '@plurid/stringbase';
import { query, field, literal, eq } from '@plurid/loque';

const db = await Stringbase.create({ filepath: './app.deon' });

try {
    await db.createCollection('records');
    const records = db.collection('records');

    const inserted = await records.insertOne({ name: 'Ada', active: 'true' });
    const matches = await records.find(
        query().where(eq(field('active'), literal('true'))).limit(20),
    );
    console.log(matches);

    await records.updateOne(inserted.id, { active: 'false' });
    await records.replaceOne(inserted.id, { name: 'Ada Lovelace', active: 'true' });
    await records.deleteOne(inserted.id);
} finally {
    await db.close();
}
```

`open` never creates a missing file. `create` never replaces an existing file.
Both require an explicit SDK filepath and an existing parent directory. The CLI
may offer the existing `~/.stringbase.deon` path through an explicit default-file
option, but tests and SDK calls must not accidentally operate on a home database.

| API | Contract |
| --- | --- |
| `Stringbase.open({ filepath, mode? })` | Open and validate an existing file; default mode is read/write |
| `Stringbase.create({ filepath })` | Exclusively create an empty `{}` database and return a writer |
| `db.collection(name)` | Return a handle; do not implicitly create a collection |
| `db.listCollections()` | Return collection names in deterministic alphabetical order |
| `db.createCollection(name)` | Create an empty collection; duplicate name is an error |
| `db.dropCollection(name)` | Explicitly remove that collection and its documents |
| `collection.get(id)` | Return the raw document or `undefined` |
| `collection.find(query?, options?)` | Return a document array; omitted query selects all |
| `collection.count(query?, options?)` | Return the count after the supplied query steps |
| `collection.insertOne(document)` | Return the inserted document, including its final ID |
| `collection.insertMany(documents)` | One atomic insertion, returning documents in input order |
| `collection.updateOne(id, fields)` | Shallow field replacement/addition on one document |
| `collection.updateMany(query, fields, options?)` | Apply the same shallow update to selected documents |
| `collection.replaceOne(id, fields)` | Replace all non-ID fields of one document |
| `collection.deleteOne(id)` | Remove one document |
| `collection.deleteMany(query, options?)` | Remove selected documents |
| `db.read(locator, options?)` | Locator shorthand; consistently return a document array |
| `db.batch(callback)` | Run a synchronous transaction callback and commit its staged changes once |
| `db.reload()` | Validate and adopt the current file, serialized with other operations |
| `db.close()` | Stop admission, finish queued work, release ownership; repeated close is safe |

The `mode` option is `'readwrite' | 'readonly'`. `collection(name)` is a synchronous
handle factory; it neither reads nor changes stored state. Existence is checked
when an operation on that handle executes.

Operations on unknown collections fail with `STRINGBASE_COLLECTION_NOT_FOUND`.
A missing document ID is ordinary absence: `get` returns `undefined`, and writes
report zero matches without creating a document. Insert/update do not infer an
upsert. A replacement body cannot supply an ID; the selected ID is retained.

Update values replace a whole top-level field, including a map or a list. There
is no implicit deep merge, dotted-key interpretation, field deletion, arithmetic
operator, or mutation callback in v1. A key containing a dot remains that literal
key. Use document replacement to remove fields; a dedicated path update API can
be added later with its own rules.

Updates and replacements return `{ matchedCount, modifiedCount, ids }`; deletions
return `{ deletedCount, ids }`. Update/replacement IDs identify all matched
documents, including unchanged matches; deletion IDs identify removed documents.
IDs follow selection order. Structurally unchanged
updates count as matches but not modifications and do not rewrite the file.
An empty bulk insert or a batch with no effective changes likewise performs no
replacement. A duplicate ID anywhere in an insertion batch aborts all inserts.

All state-reading and state-changing database operations are asynchronous and
ordered through the handle's operation queue. Reads observe a committed snapshot,
never a staged batch. Each
operation determines its targets when it reaches the queue, rather than capturing
array indices that can become stale before a preceding mutation finishes.

The first version removes the ambiguous `write`, unfinished `obliterate`, global
`typer` option, and unimplemented cache modes. The release notes map them to the
new explicit operations. Keep the old code in Git history, not in a second runtime
implementation. Document the changed array result of `read` prominently.

## 5. Query contract

### Structured queries

Reuse Loque's builder and IR. Collection queries are relative to documents, with
only `where`, `sort`, `skip`, and `limit` steps in v1. Predicate field expressions
can navigate nested maps and indexed list members. Reject steps that leave the
document level, judgment expressions, and unsupported IR versions. Validate the
subset rather than accepting arbitrary executable callbacks.

Use Loque's exact equality, structural map/list equality, same-type range
comparisons, Boolean composition, own-field traversal, and stable sorting.
Missing fields do not satisfy comparisons, including `ne`; an explicit negated
predicate retains Loque's documented Boolean behavior. Default result order is
collection order. Sort ties preserve that order. Step order is meaningful:
`limit(10).sort(...)` differs from `sort(...).limit(10)`.

Raw queries see Deon strings. For example, `'12' < '2'` under ordinary string
comparison. They never acquire numeric semantics merely because a value looks
like a number. Optional application result typing uses Deon's typer explicitly.

Provide an explicit query option `view: 'raw' | 'typed'`, defaulting to `raw`, for
numeric and Boolean predicates and ordering. A typed view conservatively converts
non-ID fields using Deon's typer, retaining leading-zero and unsafe-integer strings;
the top-level document ID always stays a string. Query literals in the structured
API are supplied in the intended type by the caller. Returned documents stay raw.

Typed queries must never become a route for typed values to enter storage. Resolve
selected document IDs against the same raw snapshot before planning mutations;
do not persist the result of a mutation applied to the converted snapshot. A
regression test must prove that a numeric query followed by an unrelated update
leaves stored numeric-looking and Boolean-looking fields as strings.

### Locator shorthand

The locator is a small parser that compiles to that same query subset. The
prototype's notes inform the syntax, but do not define behavior by themselves.

```text
records
records.id:123
records.active:true & name:'Ada Lovelace'
records.(active:true | active:pending) & {profile.city}:London
records.age>=18
```

| Construct | Meaning |
| --- | --- |
| `collection` | All documents in that collection |
| `collection.field:value` | Equality predicate |
| `field!:value` | Inequality predicate |
| `<`, `<=`, `>`, `>=` | Range comparison |
| `{profile.city}` | Nested field path, rather than a literal dotted key |
| `&`, `|`, `( ... )` | AND, OR, and grouping; AND binds more tightly than OR |
| `'quoted value'` | A literal string, including spaces or operator characters |

The collection prefix appears once. Whitespace outside quoted values separates
tokens and carries no meaning; newlines may format a locator. Bare values end at
whitespace or an operator, so a value with spaces is quoted. Single quotes use
specified backslash escapes, tested against a grammar fixture table. Empty values
are written `''`; malformed or unfinished input produces a position-bearing error.

In a raw locator all values are strings, including unquoted `123` and `true`.
In a typed locator unquoted operands use Deon's conservative typer; quoted
operands remain strings. ID predicates always use string operands, matching the
typed-view ID exception. Consequently `records.age>=18` is a numeric comparison
only with `{ view: 'typed' }`; the same raw locator is a string comparison.

Represent paths internally as literal string/number segments. Milestone 2 must
freeze and test the syntax for quoted path segments and list indices, so special
keys remain addressable without splitting a literal dotted key accidentally.
Include a formal grammar and a bounded parser: initially 16 KiB of UTF-8 locator
source, 256 compiled query/predicate nodes, and 32 nested Boolean groups. Apply
equivalent limits to caller-supplied structured IR.

Sorting and pagination are query options or builder steps. The original
pipe-delimited cursors, dynamic field comparisons, joins between collections,
and traversal into nested collections are not locator syntax in v1. Reject
unsupported syntax explicitly instead of interpreting part of it.

## 6. Persistence, ownership, and manual edits

### Supported storage boundary

Initial writer support targets local filesystems on macOS and Linux, verified on
both. Windows writer support and network/shared filesystems require their own
replacement, locking, and durability evidence before being advertised. Multiple
read-only handles can coexist with a writer; each reader keeps its snapshot until
reload. This is not a multi-process live consistency protocol.

A writer holds an exclusive sidecar ownership lock for its lifetime. Locking must
coordinate independent processes and ESM/CommonJS consumers, not only one
JavaScript module instance. Resolve the real parent directory for lock identity;
reject a symlink database file or an existing multiply hard-linked file to avoid
ambiguous ownership under atomic replacement.

Create ownership atomically, with owner identity and a random ownership token.
Release only the lock still carrying that token. Never steal a lock because of
its age. An interrupted owner may leave a stale lock: report the owner details
and a documented recovery procedure. If an automated `unlock --if-dead` command
is added, it must prove local owner death and unchanged ownership; unknown hosts,
PID reuse ambiguity, and live owners fail closed. It is not required for the first
SDK milestone.

### Commit sequence

For an ordinary mutation or a complete batch:

1. Execute against the latest committed snapshot in the operation queue.
2. Construct a candidate raw snapshot; validate the complete database shape and
   ID uniqueness. Keep the currently published snapshot untouched.
3. Serialize, enforce the output byte limit, and parse/validate the result before
   beginning replacement. The file to be committed must reopen to the candidate.
4. Verify ownership and compare the current file's exact-byte fingerprint with
   the baseline captured by open, reload, or the previous successful commit.
   An observed external change is a conflict, not an invitation to merge or retry.
5. Write a unique, exclusively created temporary file in the same directory.
   Use restrictive permissions for a new database and preserve existing file
   permissions on replacement. Write all bytes and synchronize the temporary file.
6. Recheck ownership and the target fingerprint immediately before replacement.
   Replace the target with the prepared file atomically; never truncate the target
   as the way to save data.
7. Synchronize the containing directory. Only then publish the new in-memory
   snapshot, update the fingerprint, and resolve success.

Creation needs an exclusive publication primitive as well as the writer lock:
`create` must not overwrite a file that appeared after the initial absence check.
Define and test that primitive in the storage module rather than implementing
creation as an unchecked rename over the target.

Before replacement, failure leaves the old file and committed memory intact.
Clean only this operation's temporary files. A failed write must not poison the
operation queue: subsequent work can proceed when the outcome is known.

After replacement, a synchronization error or uncertain replacement result is
different: the candidate may already be visible or durable. Return
`STRINGBASE_COMMIT_UNCERTAIN`, stop admitting database operations, and require
close/reopen to recover the actual file. Do not report rollback, automatically
retry the mutation, or continue serving an assumed old snapshot. Previously
queued operations must also reject once the handle enters this state.

Crash tests can establish old-or-new valid files and recovery behavior. They
cannot certify physical media behavior under power loss; document the filesystem
synchronization assumptions behind the durability promise.

### External editing and reload

The supported manual-edit workflow quiesces database writes, edits the file, and
then reloads it or reopens the database. `reload` constructs and validates a full
candidate before swapping the current snapshot. A syntax error, duplicate ID, or
invalid collection leaves the prior in-memory snapshot usable for reads.

A failed reload does not authorize writes over the invalid external file: the
fingerprint conflict remains until a valid reload or reopen. There is no silent
reset to `{}`, automatic migration, or implicit acceptance of missing IDs.

The sidecar lock coordinates Stringbase writers. A text editor does not obey it.
Fingerprint checks detect observed edits but cannot eliminate the race against an
uncooperative editor writing between the final check and replacement. Concurrent
uncooperative editing is outside the v1 guarantee; do not advertise the checks as
a general filesystem compare-and-swap.

## 7. Atomic batches and handle lifecycle

```ts
await db.batch(tx => {
    tx.collection('records').updateOne('123', { active: 'false' });
    tx.collection('events').insertOne({ kind: 'record-disabled', recordId: '123' });
});
```

The callback is synchronous, runs once, and receives a transaction-scoped facade
with synchronous in-memory operations. Its reads see its own staged changes.
It cannot flush, reload, close, nest a batch, or remain usable after the callback.
Reject callbacks returning a promise. Do not replay user callbacks after errors.

An operation failure marks the batch failed even if the callback catches that
error. A failed callback, validation failure, or known pre-replacement persistence
failure discards all staged changes. A successful effective batch performs one
commit, including when it changes several collections. Its returned value is
provisional until the outer `db.batch` promise resolves.

Reject reentrant use of the same database handle through its ordinary API from
inside a batch callback; callers must use the transaction facade. Other callers
can queue work normally. Test this explicitly to avoid deadlocks and accidentally
scheduling a supposed batch operation as a later independent write.

Handle states are opening, open, closing, closed, and commit-uncertain. Failed open
releases any ownership it acquired. Read-only mutation attempts fail immediately.
Close establishes an admission boundary, drains work accepted before that boundary,
and releases ownership even after an operation fails. There are no background
flush timers. Cleanup failure must be reported rather than presented as a clean
close. An uncertain commit requires reopen before further database operations.

## 8. Errors and CLI

`StringbaseError` has a stable `code`, a human message, an optional original
`cause`, and structured details such as collection, ID, filepath, or locator span.
Preserve Deon diagnostics when wrapping a format failure. Match codes in tests
and integrations, not message prose or `instanceof` across separate module builds.

Initial codes:

```text
STRINGBASE_INVALID_OPTIONS       STRINGBASE_INVALID_DATA
STRINGBASE_INVALID_QUERY         STRINGBASE_INVALID_LOCATOR
STRINGBASE_FILE_NOT_FOUND        STRINGBASE_FILE_EXISTS
STRINGBASE_FILE_FORMAT           STRINGBASE_IO
STRINGBASE_LOCKED                STRINGBASE_CONFLICT
STRINGBASE_READ_ONLY             STRINGBASE_CLOSED
STRINGBASE_COLLECTION_EXISTS     STRINGBASE_COLLECTION_NOT_FOUND
STRINGBASE_DUPLICATE_ID          STRINGBASE_BATCH_FAILED
STRINGBASE_LIMIT_EXCEEDED        STRINGBASE_COMMIT_UNCERTAIN
```

The CLI uses the SDK and owns only argument parsing, payload input, formatting,
and exit codes. Use `node:util.parseArgs` unless actual command complexity justifies
a dependency; its [documented API](https://nodejs.org/api/util.html#utilparseargsconfig)
provides structured argument parsing. There is no interactive approval prompt in
command execution.

```sh
stringbase init ./app.deon
stringbase collections ./app.deon
stringbase create-collection ./app.deon records
stringbase get ./app.deon records 123
stringbase query ./app.deon 'records.active:true' --limit 20
stringbase query ./app.deon 'records.age>=18' --view typed
stringbase insert ./app.deon records --data-file ./record.deon
stringbase update ./app.deon records 123 --data-file ./fields.deon
stringbase replace ./app.deon records 123 --data-file ./replacement.deon
stringbase delete ./app.deon records 123
stringbase validate ./app.deon
```

Read and validation commands use read-only access. Payload files can contain a
single Deon map or, for bulk insert, a list of maps, under the same value/profile
rules. A payload wrapper parses an individual document rather than requiring the
database root shape. CLI queries must behave identically to SDK queries.

Successful output is JSON on stdout; diagnostics go to stderr. No progress/debug
output appears in stdout. Exit 0 means success (including empty query results and
zero-match mutations), 1 means an operational/storage failure, 2 means invalid
arguments or invalid supplied data/query, and 3 means a requested `get` ID is
absent. `validate` checks bytes, syntax, database shape, and uniqueness without
writing or taking the writer lock.

The complete CLI milestone also includes bulk update/delete with explicit query
targets and an explicit all-documents selector, collection removal, and a
versioned declarative batch payload. The batch format contains operation data,
not executable JavaScript, and is validated in full before application. Pin its
schema and fixture examples before implementing it.

## 9. Implementation shape and tooling

Keep the existing `packages/stringbase-javascript` package boundary. A small
module layout is sufficient:

```text
source/
    index.ts             public exports
    types.ts             database options, records, operation results
    errors.ts            stable error boundary
    model.ts             profile validation, IDs, protected fields, typed views
    queries.ts           constrained Loque query adapter and raw target resolution
    locator.ts           text-to-query compilation
    database.ts          handles, ordering, collections, staged batches
    storage/
        codec.ts         Deon profile inspection, decoding, validated encoding
        file.ts          ownership, fingerprints, atomic publication, recovery
    cli.ts               executable entry
```

The storage module exposes load/create/commit/reload/close behavior with explicit
known-failure and uncertain-commit outcomes. It hides temporary file and ownership
details. Database logic does not open files directly. The query module exposes
selected document identities; persistence does not depend on Loque internals.

Use TypeScript strict mode, checked indexed access, and exact optional properties;
replace `any` at public boundaries with explicit Deon/document types or `unknown`
with runtime validation. Remove the unused `commands`, extractor, custom locator
interpreter, aliases, `.unsource`, empty option logic, and obsolete build/test
configuration after their useful examples have become contract fixtures.

Tooling baseline:

- Node.js 22.12+; test the latest supported patch releases in the 22, 24, and 26
  lines. Development tools may require a newer patch, which must be recorded.
  The [Node release table](https://nodejs.org/en/about/previous-releases) currently
  lists these three lines as LTS; remove a line from the promise when support ends.
- pnpm, retaining the repository's existing package-manager choice, with a pinned
  package-manager release, a small root workspace, one lockfile, and frozen CI
  installs. Do not mix Yarn build commands into pnpm scripts.
- Use `tsdown` for ESM/CommonJS output and declarations, aligning with the modern
  Loque package. Its [format documentation](https://tsdown.dev/options/output-format)
  supports both formats; retain CommonJS as an explicit compatibility requirement.
- Give `import` and `require` their matching declaration branches. TypeScript
  [distinguishes `.d.mts` and `.d.cts`](https://www.typescriptlang.org/docs/handbook/modules/reference.html#module-format-detection);
  test both from external consumer projects rather than assuming one declaration
  file covers both module formats.
- Vitest for unit/integration tests and fault injection, with coverage of storage
  branches, plus independent type checking and a current flat ESLint configuration.
  The [Vitest 5 migration guide](https://vitest.dev/guide/migration/) sets Node
  22.12 as its minimum; confirm exact tool versions and peer compatibility at install.
- Keep Deon and Loque external runtime dependencies; do not silently vendor their
  implementations into the published package.
- Build and test the actual package tarball, executable permissions, exports,
  declaration files, and installed CLI. The published package must work without
  this repository, source aliases, or neighboring checkouts.

The new script surface should expose `build`, `dev`, `typecheck`, `lint`, `test`,
`test:coverage`, `check:docs`, `check:package`, and `verify`. Pin their exact commands
when the manifests are changed; these are planned scripts, not commands the current
checkout already supports. Publishing remains a separate action.

## 10. Delivery milestones and acceptance criteria

Implement in this order. Each milestone adds executable evidence before the next
one relies on its behavior; do not mechanically port the old directory tree.

| Milestone | Deliverable | Acceptance evidence |
| --- | --- | --- |
| 1. Freeze contracts and package baseline | Types, file profile, errors, dependency API checks, modern build/test scripts, migration notes | Deon/Loque import probes; minimal packed package loads and type-checks in ESM and CJS; a fixture round-trips through Deon |
| 2. Pure data and query layer | Collection/ID validation, immutable snapshots, structured query subset, specified locator grammar, typed query view | Shared structured/locator cases agree; special keys, missing fields, ordering, quoting, malformed input, limits, and ID preservation covered |
| 3. File storage and lifecycle | Explicit create/open, read-only access, ownership, atomic commit, conflict handling, reload/close, error outcomes | Real temporary files reopen correctly; independent-process writer contention; failure injection before/after replacement; invalid input never resets data |
| 4. Database operations and batches | All CRUD/bulk methods, queue ordering, transaction facade, one-commit batches | Two-collection batch persists together; failed batch leaves both unchanged; duplicate IDs abort; no-op writes preserve bytes; typed selections do not persist converted values |
| 5. CLI and documentation | SDK-backed commands, payload/batch schemas, executable quick start, examples and migration guide | Child-process CLI tests assert stdout, stderr, exit codes and disk effects; README examples run against isolated files |
| 6. Release verification | CI matrix, package checks, fault/recovery suite, measured operating envelope | Frozen install, lint, type check, full tests, production build, packed-consumer checks on the supported matrix; documented measurements and remaining limits |

Milestone 3 can use a minimal internal commit operation before public CRUD lands.
Milestone 4 should reuse that storage contract rather than mixing storage development
with every operation. The end of milestone 4 is the working embedded database;
milestones 5 and 6 finish the agreed CLI and package scope.

### Required integration and failure cases

- Create, insert, close, reopen, query, update, replace, delete, and reopen again;
  compare both documents and final Deon bytes where formatting is contractual.
- Unicode, leading zeros, empty strings, multiline strings, literal interpolation
  text, nested maps/lists, dangerous-looking property names, and ordinary maps
  shaped like serializer internals (such as `{ kind: 'link', name: 'value' }`)
  survive storage. Include this value corpus in dependency compatibility probes.
- Reject invalid UTF-8, malformed Deon, external dependencies, invalid roots,
  non-document collection members, missing IDs, and duplicate IDs without a write.
- Two handles and two independent processes cannot both become writers, including
  different import formats and path aliases. Closing permits the next writer.
- Read-only readers see their captured snapshot until reload; reload after a
  writer commit sees the whole new snapshot.
- External changes cause a conflict; failed reload preserves readable state and
  continues refusing writes over the unaccepted external file.
- Disk permission errors, partial temporary writes, synchronization failures,
  rename/publication failures, and directory synchronization failures receive the
  correct known/uncertain outcome. Queue behavior is checked after each outcome.
- Kill a child process at defined commit boundaries; reopen the surviving target
  and verify an intact old or new database. Test stale ownership recovery behavior.
- Test simultaneous caller operations, close while work is queued, repeated close,
  rejected operations after close, transaction-scope expiry, callback failure,
  caught operation failure, asynchronous callback rejection, and reentrant calls.
- Failed bulk validation and insert-ID collisions change no collections. A batch
  performs one publication. No-op operations do not normalize an untouched source.
- A package installed from its tarball works as an ESM consumer, CommonJS consumer,
  TypeScript consumer in both module modes, and installed CLI, with no source files.

Use real filesystem/process tests for observable durability and ownership behavior,
and inject failures through a narrow internal filesystem boundary for otherwise
unreliable error paths. Do not export a general storage plugin system just to make
tests possible. Do not use sleeps as the synchronization contract in contention tests.

Measure representative datasets with 1,000 and 10,000 documents, recording UTF-8
size, open time, scan/sort time, single commit time, batched commit time, and peak
memory. Publish measured results with environment details; set no performance
claims from estimates alone.

## 11. Decisions still requiring implementation evidence

The feature scope is settled enough to proceed. These are engineering gates, not
reasons to reopen the whole product design:

1. Which actual dependency releases contain the inspected Deon/Loque APIs, and how
   portable installation will be proven before publishing.
2. The exact locator grammar for escaping, quoted path segments, and list indices;
   freeze it with fixtures in milestone 2 before writing its parser.
3. The POSIX ownership and exclusive-create primitives, and which errors make a
   commit outcome uncertain; prove them in the storage tests.
4. The declarative CLI batch schema, fixed before CLI implementation.
5. Whether the initial size/query limits and supported platform matrix need
   adjustment after the measured operating envelope and CI results.

Do not add extra features to get around a failed gate. Record the concrete result,
adjust the relevant contract, and keep the rest of the design intact.
