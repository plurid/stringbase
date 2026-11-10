# Stringbase MCP

Stringbase agent workspaces over stdio using the official Model Context Protocol
SDK. This package is part of the unreleased Stringbase modernization.

From a checkout, run `pnpm install --frozen-lockfile` and `pnpm build` at the
repository root. Create a workspace using the Stringbase CLI, then start:

```sh
node packages/stringbase-mcp/distribution/cli.mjs ./catalog-workspace --actor catalog-agent
```

Configure the same command and arguments in an MCP client. The server exposes
describe, fork, query, plan, apply, diff, history, submit, and discard tools.
The host-selected actor cannot be changed through tool arguments. Existing run
access must be explicitly granted with `--run <id>` and match that actor.

Agents cannot approve, promote, export, or alter policies through this server.
Stored values are strings, lists, and maps. Responses contain both structured
JSON and equivalent text, with stable errors and retry guidance.

There is one writer process per local workspace. Stdin EOF and graceful shutdown
release its lock. Stop the standalone server before opening another writer CLI.
Embedded applications may use `createStringbaseServer` and its returned
`workspace` for host review, or use `createAgentTools` from
`@plurid/stringbase/agent` to serve several actor-bound contexts in one process.

The server opens only its configured workspace. Tool permissions do not constrain
an agent separately granted operating-system filesystem access. Host code owns
identity and reviewer decisions; this local server has no remote identity service.

See the [workspace guide](https://github.com/plurid/stringbase/blob/master/docs/agent-workspaces.md)
and the [catalog example](https://github.com/plurid/stringbase/tree/master/examples/catalog).
