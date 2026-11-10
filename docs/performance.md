# Initial operating measurements

Measured on macOS arm64 with Node.js v26.8.2, using
`pnpm --filter @plurid/stringbase benchmark`. Each dataset runs in its own process
and temporary directory. These are single-run observations, not latency guarantees.
Files are generated immediately before reopening, so reads can benefit from the
filesystem cache. No other verification processes ran during this measurement.

| Documents | File bytes | Open ms | Filter ms | Typed sort ms | Single commit ms | Batch of 10 updates ms | Peak process RSS MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1,000 | 107,924 | 14.04 | 2.64 | 3.71 | 28.15 | 79.67 | 168.4 |
| 10,000 | 1,106,924 | 117.50 | 19.71 | 26.08 | 208.70 | 715.77 | 406.8 |

Documents have string IDs, names, groups, and ranks. The filter selects one group;
the sort uses a typed numeric rank and returns 20 documents. A single commit updates
one document. The batch makes ten staged document updates and one durable commit.
Peak RSS includes setup, query snapshots, validation, and serialization for the
entire child process, rather than only the steady-state open database.

The implementation scans collections and rewrites the complete file on commit.
Staging several updates also creates intermediate immutable snapshots, so a batch
reduces publications without making mutation work independent of database size.
Choose datasets that fit comfortably in memory. The default 64 MiB file-size cap
is a byte limit, not an equivalent RAM requirement or a measured capacity claim.

Reproduce measurements on the deployment filesystem before setting a workload
budget. The benchmark script records Node version, platform, architecture, dataset
size, timing, and process peak RSS as JSON.

Local verification also passed `pnpm verify`: 57 tests, lint, type checking,
production build, runnable documentation, and an isolated installed-tarball
consumer covering ESM/CommonJS, CLI, and NodeNext/Bundler type resolution.
Statement coverage was 90.87%, branch coverage 86.65%, and line coverage 95.38%.
The macOS/Linux and Node 22/24/26 CI matrix is configured; those additional runners
were not executed from this local session.

## Agent workspace measurements

Measured separately after the agent implementation, on the same macOS arm64 and
Node.js v26.8.2 environment. Run `pnpm --filter @plurid/stringbase benchmark:workspaces`.
Each dataset runs in its own process and temporary directory. No other verification
commands ran during this measurement. These are single-run observations with warm
filesystem data and the workspace's bounded immutable snapshot cache, not latency
or capacity guarantees.

The workflow creates a catalog, forks five alternative runs, queries ten records,
plans and applies one ten-record update, submits it for host review and approval,
promotes it, and reopens the workspace. Fork timings include five sequential durable
manifest publications. Peak RSS covers the complete child process, including setup,
serialization, validation, and reopening history; it is not steady-state memory.

| Records | Initial workspace bytes | Five forks ms | Query ms | Plan ten ms | Apply ten ms | Peak RSS MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000 | 180,028 | 55.73 | 6.63 | 23.27 | 53.13 | 184.4 |
| 10,000 | 1,809,028 | 54.85 | 31.96 | 101.70 | 329.26 | 526.8 |

| Records | Create ms | Review ms | Promote ms | Reopen ms | Final workspace bytes |
| --- | --- | --- | --- | --- | --- |
| 1,000 | 63.82 | 2.98 | 16.09 | 36.55 | 376,863 |
| 10,000 | 283.18 | 20.99 | 38.05 | 353.82 | 3,634,863 |

Both datasets retained one snapshot after five forks; only metadata grew, by
3,903 bytes. Applying the update created a second complete snapshot. Promotion
reused it, so the complete workflow retained two snapshot objects. This is shared
immutable snapshot branching; changed snapshots still rewrite the entire dataset.

Start pilots with approximately 1,000 selected records, then measure the actual
catalog fields and run history before expanding. The 10,000-record observation
shows substantial memory overhead even for a small encoded dataset. The 64 MiB
snapshot limit is a parsing/storage guard, not demonstrated working capacity.
Queries scan collections; manifest publication and reopen work grow with retained
history. No distributed-storage or large-database performance claim is implied.

The final local `pnpm verify` passed 86 database/workspace tests and two real MCP
tests, including process termination before/after publication, policy revocation,
stale approvals, receipts, CLI flows, executable docs, the catalog reference, and
isolated production installs of both packages. Statement coverage was 92.54%,
branch coverage 87.51%, function coverage 97.87%, and line coverage 97.08%.
