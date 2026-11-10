# Agent workspaces

Stringbase gives agents an isolated working revision and gives the host application
an explicit review and publication boundary. The existing single-file database
API remains available. Workspaces use a separate directory and the
`@plurid/stringbase/agent` entry point, with ESM and CommonJS support.

## Run the reference workflow

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node examples/catalog/run.mjs
```

The example imports catalog text, prepares a proposal, exercises host approval,
and publishes through a reference host transaction. It asserts that numeric
prices, inventory, booleans, and nulls stay in the host application, unchanged.
It also demonstrates rejection of concurrent source edits.

## SDK

This complete example uses an explicit host decision where a real application
would present its review to a person:

```javascript
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@plurid/stringbase/agent';

const directory = await mkdtemp(join(tmpdir(), 'stringbase-guide-'));
const policy = {
    version: 'catalog-1',
    read: ['/products/*'],
    write: ['/products/*/description'],
    schema: { products: {
        title: { kind: 'string', required: true },
        description: { kind: 'string', required: true, maxLength: 400 },
    } },
};
const workspace = await Workspace.create({
    directory: join(directory, 'workspace'),
    data: { products: [{ id: '01', title: 'Desk lamp', description: 'A lamp' }] },
    policy, sourceRevision: 'catalog-42', actor: 'catalog-app',
});
try {
    const run = await workspace.fork({ actor: 'catalog-agent', requestId: 'fork-1' });
    const agent = workspace.agent(run.id);
    const plan = await agent.plan({
        version: 1, collection: 'products',
        query: { version: 1, steps: [] },
        mutation: { op: 'merge', value: { description: 'Adjustable task lighting.' } },
    }, { requestId: 'plan-1' });
    assert.deepEqual(plan.findings, []);
    await agent.apply(plan.id, { requestId: 'apply-1' });
    const proposal = await agent.submit({ requestId: 'submit-1' });
    const review = await workspace.review(proposal.id);
    assert.equal(review.total, 1);

    // The host calls this only after its user approves the displayed review.
    const approval = await workspace.approve(proposal.id, {
        reviewer: 'catalog-owner', requestId: 'approve-1',
    });
    await workspace.promote(approval.id, {
        reviewer: 'catalog-owner', requestId: 'promote-1',
    });
    const exported = await workspace.exportChanges();
    assert.equal(exported.changes[0].id, '01');
    assert.equal(exported.sourceRevision, 'catalog-42');
} finally {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
}
```

Agent programs contain a collection name, a document-level Loque QueryIR, and
optionally one merge mutation. They support deterministic where/sort/skip/limit
steps. Queries may specify `fields` to project readable top-level fields; `id`
is included and must also be readable. Mutation programs cannot project fields.
Judgments, executable callbacks, inserts, deletes, collection changes, and ID
changes are unavailable through the agent API.

Raw values remain strings, lists, and maps. A literal `"01"` stays `"01"`.
Numeric, boolean, and null source fields require an explicit host mapping or
remain outside the imported projection. No automatic conversion is performed.

## Host policy and validation

Policies use Loque JSON Pointer capabilities. `read`, `write`, and optional
`deny` patterns are checked before selecting data. A whole-document read needs
permission for the whole document; use a projection for narrower grants.
Planning also needs read permission for changed fields because its report
contains old values. A model cannot supply its own policy or actor identity.

The host declares each imported non-ID field with `kind: string`, `strings`
(a list of strings), or `map` (a map of strings). Rules support `required`,
`minLength`, `maxLength`, and string `enum` values. Length measures Unicode code
points for strings and entry counts for lists/maps. Undeclared collections and
fields fail validation. Validation findings can be previewed, but invalid plans
cannot be applied or promoted. These checks do not verify generated claims.

Defaults per policy are 100 matches, 256 operations, 50 query results, and
256 KiB of JSON output. Match/operation/result limits may be configured up to
10,000; output may range from 1 KiB to 4 MiB. Existing query node/depth limits
also apply. Use bounded queries, projections, and paginated reviews rather than
requesting an entire large catalog.

Policies are versioned and retained for historical replay. `setPolicy` requires
a new version for changed content and immediately revokes sessions based on the
old policy, including attempts to retrieve their old operation results.

## Lifecycle and consistency

- `fork` records the accepted base revision. A run is open until it is submitted
  or discarded. Submission freezes its source revision.
- `plan` records the program, base revision, policy digest, changes, and findings.
  `apply` revalidates it and requires the original branch head.
- `review` pages through changes identified by collection, document ID, and
  top-level field. Lists and maps are replaced as complete field values.
- `approve` binds the reviewer decision to source, target, policy, and diff.
  `promote` rechecks all of them and records the approval ID in the revision.
- V1 requires the accepted target to remain at the run's original base. A stale
  proposal needs a new run and fresh approval. Automatic merging is deferred.
- `reject` closes a submitted run. `revert` creates a new commit restoring the
  current accepted promotion's parent. Earlier history is retained.
- `history`, `receipt`, and `replay` are host inspection APIs. Agent history is
  restricted to that session's own run. Replay uses the recorded program and
  its original policy, without calling a model.

Every mutation takes a `requestId`. Retain it on retries. The durable receipt
and state change publish together; reuse with different input is a conflict.
IDs are workspace-wide, so use UUIDs across concurrent actors and runs.
Query responses carry a revision. Pass `expectedRevision` while paging to reject
reads after a branch change. `nextSkip` identifies a possible next page; a full
final page can be followed by an empty page.

## Publishing to an existing application

Promotion accepts data inside Stringbase. It does not write to the source
application. Only host APIs can export promoted/reverted revisions.

Exports carry a source revision and old/new values for each allowed field.
The host must atomically check source preconditions and apply the patch through
its own database or application transaction. The reference implementation is
`examples/catalog/publish.mjs`; it stages all changes before returning updated
source data. Treat exports received directly from an agent as untrusted input.
After successful publication, import a fresh source snapshot and revision for
the next run. External rollback also belongs to the host application.

## CLI and MCP

```sh
node packages/stringbase-javascript/distribution/cli.mjs workspace init ./catalog-workspace \
  --snapshot examples/catalog/snapshot.json --policy examples/catalog/policy.json \
  --source-revision catalog-1 --actor catalog-app
node packages/stringbase-javascript/distribution/cli.mjs workspace --help
node packages/stringbase-mcp/distribution/cli.mjs ./catalog-workspace --actor catalog-agent
```

The CLI has explicit host commands for review, approve, promote, reject, export,
import, policy, history, receipt, replay, and revert. Agent commands also work
through it. JSON success goes to stdout and errors to stderr. Mutating commands
return their request IDs; supply `--request-id` to retry an interrupted command.

The stdio MCP server exposes describe, fork, query, plan, apply, diff, history,
submit, and discard. Its actor comes from host configuration. It grants only
runs created through that adapter, or explicit startup `--run` grants belonging
to the same actor. Approval/promotion/export/policy are absent from its tool list.

For embedding, `createAgentTools(workspace, { actor, runIds? })` provides the same
transport-neutral tools. Several actor-bound adapters can share one writer
process. The MCP library's `createStringbaseServer` returns `server`, `workspace`
(for the trusted host), and `close`. The standalone server releases its writer
on stdin EOF or graceful shutdown. Close it before using another writer CLI.

## Storage and operation

The workspace contains `manifest.deon` and `objects/<sha256>.deon`. Objects are
immutable full snapshots. Forks share snapshots; mutations store full snapshots.
The manifest publishes revision references and receipts using the same
write/sync/rename/directory-sync protocol as the existing database. Newly created
workspaces and files use private permissions. Writers target local macOS/Linux
filesystems, with one cooperating writer per workspace.

The process caches up to two immutable snapshots with a combined encoded size
of at most 8 MiB. Larger snapshots are read on demand. Encoded size is not a RAM
estimate; reopen verifies referenced objects independently of a prior cache.

Default limits are 64 MiB per snapshot and 256 MiB for the workspace's manifest
and object files; configure budgets at creation. Keep reachable history. A writer
reopen checks all referenced objects and removes only recognized unpublished
objects/temporary files. A readonly opener verifies without cleanup. There is
no automatic retention deletion or stale writer-lock takeover.

`STRINGBASE_COMMIT_UNCERTAIN` requires closing and reopening before any further
use. Inspect the durable request receipt before retrying. After a crashed writer,
verify that its recorded PID/host is no longer active before manually removing
that exact manifest lock directory. Back up the complete closed workspace.

Workspaces provide logical data isolation and local history. The trusted host
owns actor identity and review decisions; direct operating-system filesystem
access is outside tool capability enforcement. Hosted identity, remote sharing,
tamper-resistant audit storage, and automatic publication are later milestones.

See [business validation](agent-business-case.md) and [measurements](performance.md).

## Live Codex trial

The catalog example above uses a fixed program. For an actual model to discover
and use the MCP tools, run:

```sh
pnpm build
codex login status
pnpm trial:codex
```

This opt-in command uses the existing Codex CLI sign-in and its default model.
It makes live model calls and consumes the account's usage allowance. It is
separate from `pnpm verify`, whose runner tests use an explicitly simulated agent.
Use `--model <model>` to choose a model and `--timeout <seconds>` to bound the run
(180 seconds by default; 600 maximum). `--output <new-directory>` preserves a
trial in a chosen directory; the default is a private temporary directory.

The host imports the two sample products, creates one granted run, and allows
description edits only. Codex receives per-invocation MCP configuration, an empty
working directory, a read-only command sandbox, and disabled shell/delegation
tools. The existing Codex configuration is not edited. MCP execution uses its
normal tool host; the Stringbase tools are the data-access boundary.

The runner saves `report.json`, `review.md`, the final model response, JSONL
events, and CLI diagnostics. It checks the actual stored proposal, run ownership,
field changes, validators, both products, accepted head, and observed tool calls.
Passing sets `status: ready_for_review`; it does not approve, promote, export, or
publish the proposal. Inspect `review.md` and use the trusted host CLI for any
subsequent reviewer decision. Failures retain the workspace and available logs.

The CLI must already be installed and signed in. The command uses official
[Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
and [local MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
CLI versions may expose different configuration features; the tested version
was 0.167.0.
