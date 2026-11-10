# Stringbase

An embedded document database stored in a human-readable `.deon` file.

**Unreleased modernization: `0.0.0-1`.** This checkout implements the new API;
older registry releases still expose the prototype. See the
[modernization plan](https://github.com/plurid/stringbase/blob/master/docs/modernization-plan.md)
and [migration notes](https://github.com/plurid/stringbase/blob/master/docs/migration.md).

Stringbase owns database operations and durable commits. [Loque](https://github.com/plurid/loque)
provides immutable queries and mutation plans; [Deon](https://github.com/plurid/deon)
provides the notation, evaluation, and serialization.

## Develop from this checkout

Use Node.js 22.18+, 24.11+, or 26+ for development, and pnpm 12.4.1.
The built library requires Node.js 22.12+. Writer support targets local filesystems
on macOS and Linux. CI checks the latest patch releases of Node 22, 24, and 26 on
both operating systems.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

Installation builds a pinned public Deon source revision in a temporary directory.
Loque is a pinned public Git subdirectory build dependency. No neighboring
repositories are required or modified. Both implementations
are included in the built package, which has no runtime dependencies. This avoids
requiring consumers to build Git subdependencies or install the older registry APIs. Details:
[dependency compatibility](https://github.com/plurid/stringbase/blob/master/docs/dependency-compatibility.md).

To build and try the CLI directly:

```sh
pnpm build
node packages/stringbase-javascript/distribution/cli.mjs --help
```

## Use the database

This complete example creates a new file. `create` refuses an existing file;
use `open` to load one.

```javascript
import Stringbase, { query, field, literal, eq } from '@plurid/stringbase';

const db = await Stringbase.create({ filepath: './app.deon' });
try {
    await db.createCollection('records');
    await db.createCollection('events');
    const records = db.collection('records');

    await records.insertOne({ id: '01', name: 'Ada', active: 'true', age: '37' });
    const active = await records.find(
        query().where(eq(field('active'), literal('true'))),
    );
    console.log(active);

    await db.batch(tx => {
        tx.collection('records').updateOne('01', { active: 'false' });
        tx.collection('events').insertOne({ kind: 'disabled', recordId: '01' });
    });
} finally {
    await db.close();
}

const reopened = await Stringbase.open({ filepath: './app.deon', mode: 'readonly' });
try {
    console.log(await reopened.collection('records').get('01'));
} finally {
    await reopened.close();
}
```

Every successful mutation is committed before its promise resolves. Opening and
reading preserve authored bytes. **The first effective mutation writes normalized
inline Deon: comments and the arrangement of leaflinks/structures are not retained.**
No-op updates do not rewrite a file.

CommonJS consumers use `const { Stringbase } = require('@plurid/stringbase')`.
ESM and CommonJS have separate matching TypeScript declaration entry points.

## Data model

A database is a map of named collections. Each collection is an ordered list of
maps with a nonempty string `id`, unique within that collection:

```deon
{
    records [
        {
            id 01
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

All scalar values are strings. SDK writes accept strings, lists, and plain maps;
convert application numbers or booleans explicitly before insertion. Null,
undefined, accessors, sparse arrays, cycles, invalid Unicode, and class instances
are rejected. Nested maps and lists are supported. Inputs are copied and returned
values are deeply immutable. Map access uses own properties, including special
keys such as `__proto__`.

IDs are immutable, case-sensitive strings. Inserts without an ID receive a UUID.
Replacement retains the selected ID; update/replacement bodies cannot include it.
Collection names match `[A-Za-z_][A-Za-z0-9_-]*`.

Database files may use self-contained Deon leaflinks, spreads, structures, and
entity calls. Imports, injections, and environment references are rejected. No
filesystem imports, network requests, or ambient environment reads occur while
parsing a database. Empty or malformed files never become an empty database
silently.

## API

`Stringbase.open({ filepath, mode?, maxFileBytes? })` loads an existing file.
`Stringbase.create({ filepath, maxFileBytes? })` exclusively creates an empty one.
The filepath is required, and its parent directory must already exist. The mode
is `readwrite` (default) or `readonly`; the default file-size limit is 64 MiB.
Values may nest up to Deon's 128-level limit.

| Database method | Result |
| --- | --- |
| `collection(name)` | A synchronous handle; does not create a collection |
| `listCollections()` | Alphabetically sorted collection names |
| `createCollection(name)` / `dropCollection(name)` | Create / remove a collection |
| `read(locator, options?)` | An array of raw matching documents |
| `batch(callback)` | Callback result after one successful commit |
| `reload()` | Validate and adopt the current file |
| `close()` | Drain admitted work and release writer ownership |

| Collection method | Result |
| --- | --- |
| `get(id)` | Document or undefined |
| `find(query?, options?)` | Document array, in selection order |
| `count(query?, options?)` | Number after the supplied query steps |
| `insertOne(document)` / `insertMany(documents)` | Inserted document(s), including generated IDs |
| `updateOne(id, fields)` / `updateMany(query, fields, options?)` | matchedCount, modifiedCount, ids |
| `replaceOne(id, fields)` | matchedCount, modifiedCount, ids |
| `deleteOne(id)` / `deleteMany(query, options?)` | deletedCount, ids |

State-reading and state-changing methods return promises. Queries default to all
rows; bulk mutations require an explicit query. Unknown collections are errors.
Missing IDs produce undefined or zero matches; operations do not infer upserts.
Updates replace/add whole top-level fields, with no deep merge or dotted-key
interpretation. Use replacement to remove fields. Updates report all matched IDs,
including unchanged matches. A duplicate ID aborts an entire bulk insert.

## Query with Loque

The package re-exports `query`, `fromIR`, `current`, `field`, `literal`, `eq`, `ne`,
`lt`, `lte`, `gt`, `gte`, `isIn`, `exists`, `and`, `or`, and `not` from Loque.
Collection queries support `where`, `sort`, `skip`, and `limit`. Predicates can
navigate nested fields and indexed list members. They cannot leave document
level or call probabilistic judgments.

```typescript
const matches = await db.collection('records').find(
    query().where(eq(field('profile', 'city'), literal('London')))
        .sort(field('name'))
        .skip(0)
        .limit(20),
);
```

Default comparisons are exact, without coercion: `'12' < '2'` as strings.
Missing fields do not satisfy comparisons, including inequality. Sorts are stable;
unspecified order is insertion order. Query step order matters.

For numeric/Boolean comparisons, request a typed query view explicitly:

```typescript
const adults = await db.collection('records').find(
    query().where(gte(field('age'), literal(18))),
    { view: 'typed' },
);
```

The typed view uses Deon's conservative typer for non-ID fields. Leading-zero
values and unsafe integers remain strings; top-level IDs always remain strings.
**Results and persisted data stay raw strings.** Typed filtering/sorting never
changes a field's stored type.

## Locator shorthand

Locators compile into the same deterministic Loque query representation:

```text
records
records.id:01
records.name:'Ada Lovelace'
records.active:true & {profile.city}:London
records.(active:true | active:pending) & age>=18
records.{items[0]['literal.key']}:value
```

Use `:` for equality, `!:` for inequality, `< <= > >=` for ranges, `&` for AND,
and `|` for OR. AND binds more tightly; parentheses override precedence. Braces
hold nested paths. Quoted path segments are literal map keys; unquoted bracket
digits are list indices. Quote a top-level key containing a dot.

Bare values end at whitespace/operators. Quote spaces, empty values, or operator
characters with single quotes. Escapes include `\\`, `\'`, `\n`, `\r`, `\t`, and
`\u{hex}`. Unknown escapes retain the backslash. In the raw view all operands
are strings. In a typed view, bare operands use the conservative typer; quoted
operands and ID operands stay strings.

`db.read(locator, { view, sort: { path: ['age'], direction: 'desc' }, skip, limit })`
returns an array consistently. The grammar is in `spec/locator.ebnf`. Limits are
16 KiB of locator text, 256 comparisons, and 32 nested Boolean groups. Unsupported
legacy cursors and dynamic joins produce errors.

## Atomic batches

A batch callback runs once and synchronously against staged data, using `tx`.
Its collection methods are synchronous; reads see earlier staged changes. The
callback cannot return a promise or call the ordinary database API. Transaction
handles expire after the callback. An operation failure aborts the batch even if
the callback catches it. Successful effective batches publish once; callbacks are
never replayed after failure.

For serialized operations, use `applyBatch(db, { version: 1, operations: [...] })`.
See [batch format](https://github.com/plurid/stringbase/blob/master/docs/batch-format.md).
The CLI accepts the same format. Payloads contain data, not executable JavaScript.

## Persistence and recovery

Each writer holds a sidecar `<file>.stringbase-lock` directory. A second cooperating
writer fails with `STRINGBASE_LOCKED`, including across independent processes or
module formats. Read-only handles can coexist and retain a snapshot until reload.
Symlink database files and multiply hard-linked files are rejected.

Commits validate and serialize the next snapshot, synchronize a same-directory
temporary file, verify ownership and the on-disk fingerprint, replace the target
atomically, and synchronize its directory before acknowledging success. New
files use mode 0600; replacements retain existing mode bits. Batches share this
same commit path.

A known failure before replacement leaves committed memory and bytes unchanged.
`STRINGBASE_COMMIT_UNCERTAIN` means replacement may have happened: the handle
stops serving operations and must be closed/reopened. Do not retry such a write
as though it definitely rolled back.

Manual edits require quiescing writes, editing, and calling reload or reopening.
A failed reload preserves the last readable snapshot and refuses writes over the
unaccepted edit. Fingerprint checks detect observed external changes; they cannot
prevent a text editor racing the final replacement check. Network filesystems
and concurrent uncooperative editing are outside the writer contract.

After a process crash, inspect the lock's owner.json. Once the original owner is
confirmed dead on the recorded host and all writers are stopped, remove that
specific stale lock and reopen. The SDK never steals an old lock automatically.
An interrupted operation may leave a named `.stringbase-*.tmp` file in the database
directory; inspect and remove only confirmed orphaned temporary files. A crash
while first creating a file can leave a complete target hard-linked to its
orphaned temporary file: removing the confirmed orphan restores a single link.

Filesystem synchronization and atomic replacement assumptions apply. SIGKILL tests
verify old-or-new valid database files; they do not certify physical media under
power loss. Every commit rewrites the whole database, so use atomic batches to
amortize that cost. This version has no indexes, background flushing, or live file
watcher.

## CLI

After installing a built package, use `stringbase`; in this checkout use
`node packages/stringbase-javascript/distribution/cli.mjs`.

```sh
stringbase init app.deon
stringbase create-collection app.deon records
stringbase insert app.deon records --data-file record.deon
stringbase query app.deon 'records.age>=18' --view typed --limit 20
stringbase update app.deon records 01 --data-file fields.deon
stringbase replace app.deon records 01 --data-file replacement.deon
stringbase delete app.deon records 01
stringbase delete-many app.deon 'records.active:false'
stringbase delete-many app.deon records --all
stringbase batch app.deon --operations batch.json
stringbase validate app.deon
```

Insert payloads are Deon maps or lists of maps. Update/replacement payloads contain
only non-ID fields. Query sorting accepts a literal key or JSON path array, for
example `--sort '["profile","city"]'`; `--descending` requires --sort. Bulk
update/delete require a filtered locator or an explicit collection --all selector.

Success writes JSON to stdout. Errors go to stderr. Exit codes: 0 success
(including empty results), 1 operational/storage error, 2 invalid arguments/data/
query, 3 missing ID for get. `--help` lists all commands; `--version` reports the
package version.

Errors expose stable `StringbaseError.code` values and optional details/cause.
Deon parse errors remain available through cause. Match the code, not message text
or class identity across ESM/CommonJS module instances.

## Checks and measurements

`pnpm verify` runs lint, type checking, production build, coverage tests, runnable
documentation, and an isolated installed-tarball consumer check. Tests exercise
real files, separate processes, interrupted writes, conflicts, failed commits,
transaction rollback, and CLI exit/output behavior. `pnpm --filter @plurid/stringbase
benchmark` measures 1,000 and 10,000 documents in isolated processes; results and
method are recorded in docs/performance.md.

License: see LICENSE and LICENSE.deon.
