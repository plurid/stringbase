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
