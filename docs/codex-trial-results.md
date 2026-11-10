# First live Codex catalog trial

On November 10, 2026, Codex CLI 0.167.0 used the local Stringbase MCP server
with the existing ChatGPT sign-in and the CLI's default model. This was a live
model run, separate from deterministic tests.

The host provided one isolated run with description-only write permissions.
Codex completed eight MCP calls: describe, query, plan, apply, plan, apply, diff,
and submit. The run ended with a pending human-review proposal. The accepted
revision remained unchanged.

| Product | Before | Proposed description |
| --- | --- | --- |
| Desk lamp (`01`) | A lamp | This is a desk lamp. |
| Hand drill (`02`) | A drill | This is a hand drill. |

The proposal passed the schema, ownership, revision, requested-field, and
completion checks. The transcript contained Stringbase MCP calls and no shell,
file-change, or web-search events. The run took 42.219 seconds and reported
161,200 input tokens, including 126,464 cached input tokens, plus 894 output
tokens. Usage is the CLI's cumulative turn report, not a dollar-cost estimate.

An initial configuration attempt failed because disabling the Codex code-mode
tool host also disabled MCP execution. That setting was removed. The successful
run retained the read-only command sandbox and disabled shell/delegation tools.

This establishes that a real agent can discover the schema, form supported
programs, make scoped changes, inspect them, and submit a reviewable proposal.
It does not establish catalog-scale performance, semantic evaluation accuracy,
review-time savings, or willingness to pay. The next dataset should contain
representative customer records and a measured human-review baseline.

Reproduce with `pnpm build` followed by `pnpm trial:codex`. Generated review
packets are local artifacts and should not be committed with customer data.
