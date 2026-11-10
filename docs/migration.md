# Migrating from the prototype

The prototype was `0.0.0-0`; the modernized package is `0.0.0-1`. These APIs are
intentionally explicit rather than an emulation of unfinished behavior.

| Prototype | Modern API |
| --- | --- |
| new Stringbase(options), initialize() | await Stringbase.open(options), or create(options) for a new file |
| read(locator), sometimes a single value | read(locator) always returns documents; collection.get(id) returns one document or undefined |
| write(locator, data) | insertOne/insertMany, updateOne/updateMany, or replaceOne |
| obliterate(entity, field, value) | deleteOne(id) or deleteMany(query) |
| unstored/destored queues and cache modes | Immediate commits, immutable in-memory snapshots, explicit atomic batches |
| global typer option | Explicit typed query view; raw storage/results remain strings |
| implicit home filepath | Required SDK filepath |

Files must contain named collections whose values are lists of documents with
unique nonempty string IDs. The SDK does not reinterpret an arbitrary object or
standalone scalar as that format. Convert legacy data explicitly, assign missing
IDs, and inspect the resulting Deon before opening it for writes.

SDK input scalars must be strings. For example, convert active:true to
active:'true' before insertion. Deon source scalars already parse to strings.
Duplicate IDs are errors, not an instruction to merge or overwrite.

Update bodies replace whole top-level fields. Replacements preserve only the ID
and the newly supplied fields. Neither operation accepts an ID field in its body.
No operation implicitly upserts. Collections are explicitly created before use.

The first effective mutation normalizes authored Deon, removing comments and
materializing internal links/structures. Imports, injections, and environment
references are outside the writable database profile. Keep a source copy if its
authored arrangement matters; opening and no-op writes preserve original bytes.

Use try/finally with close(). A writer owns its file until close, including while
idle. After COMMIT_UNCERTAIN, close and reopen to inspect actual state instead of
blindly retrying. A stale lock after process death requires explicit recovery.

The old locator cursor pipes, cross-collection comparisons, and nested-collection
traversal were aspirations in the notes, not preserved v1 syntax. The supported
grammar is spec/locator.ebnf; invalid trailing syntax is rejected completely.

For local development, the dependency source pins replace the obsolete registry
APIs. See dependency-compatibility.md before changing them or publishing.
