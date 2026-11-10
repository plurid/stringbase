# Business hypothesis and pilot plan

Stringbase's first customer is an engineering team building catalog agents for
other organizations. The initial buyer is the engineering/platform lead who
must let customers inspect and authorize changes before enabling publication.

The proposed value is an embeddable proposal-to-publication workflow: scoped
data, isolated runs, bounded changes, previews, validation, reviewer decisions,
and execution records. The customer keeps its primary database and model
provider. Catalog enrichment is the initial demonstration, rather than a
requirement to replace the customer's application database.

## Paid use case

A platform runs enrichment for several merchants. Agents prepare descriptions,
categories, and tags. Merchants receive a review showing changes and validation
findings, approve a specific revision, and publish through the platform's normal
application transaction. Prices, inventory, and unrelated fields stay under the
application's control. The platform can answer who proposed, reviewed, and
published each accepted change, and can reproduce its recorded operations.

The engineering budget comes from avoiding repeated development and operation
of these controls across customer accounts. This is a hypothesis to validate;
the repository's executable example establishes behavior, not customer ROI.

Database branching alone is established elsewhere. [Turso](https://turso.tech/solutions/ai-agents)
targets agent databases, and [Dolt](https://www.dolthub.com/docs/introduction/use-cases/audit/)
provides data history and audit capabilities. Stringbase must win on integration
effort and the complete controlled-change workflow. Deon readability and Loque
programs support the experience but do not establish a commercial moat.

## Pilot execution

Recruit three to five teams already building catalog automation. Before coding
customer-specific integrations, record their current review/publish process,
engineering effort, batch volumes, rejected changes, and failure recovery work.
Ask which controls their own customers demand before granting write access.

Each pilot should:

1. Integrate one selected text projection and one real host export transaction.
2. Compare reviewed publication time against the team's existing process.
3. Exercise forbidden edits, concurrent source changes, rejected proposals,
   interrupted runs, and request retries with their data.
4. Use the workflow weekly for four weeks and record continued usage.
5. Obtain a purchasing decision for a shared managed version.

Record time to first approved export, review minutes per accepted batch,
rejection/rework rate, weekly active teams/workspaces, operating/storage cost,
and willingness to pay. `examples/catalog/pilot-scorecard.csv` is the collection
template. Do not count seeded example runs as pilot adoption.

## Service gate and pricing experiment

Build the paid shared service after at least three teams use the workflow weekly
for four weeks and two commit to paying. Test $1,000 per organization per month
as an initial managed-service offer. This is a proposed price, not demonstrated
demand or a valuation estimate. The existing SDK/local-tool license stays intact.

The initial paid service would add authenticated organizations, shared review
APIs, reviewer roles, policy administration, backups, retention controls, quotas,
and usage reporting. Expansion should follow the number of customer workspaces
and operational requirements within each platform.

If teams only want SQL-compatible clones, general agent memory, or bespoke
connectors, revisit the product hypothesis before investing in managed storage.
The implementation currently delivers the SDK, CLI, MCP, catalog reference, and
local execution records. Recruitment, paid commitments, hosting, and enterprise
identity remain business and follow-up engineering work.
