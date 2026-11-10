# Dependency provenance and compatibility

Registry metadata checked during implementation: @plurid/deon latest was
0.0.0-10; @plurid/loque latest was 0.0.0-0. Those version numbers do not provide
the modern APIs used here. Installation therefore pins public Git revisions:

| Dependency | Revision | Integration |
| --- | --- | --- |
| Deon | 1fab7fb5bf32e03f4f491101c7aee6bf8b406c32 | Pure source built and bundled |
| Loque | 6bc497247cd862107cb68bfc3a6bbd99a0db50e0 | Deterministic engine, programs and capabilities built and bundled |

The pnpm workspace explicitly allows preparation of those exact Git artifacts
for development. Both libraries are bundled into the published output and have
matching inlined declaration types. A production consumer has no Git dependency,
installation scripts, or runtime dependency tree. This also avoids pnpm's default
block on exotic transitive dependencies, which the isolated consumer check exposed.
Loque's deterministic query helpers are re-exported from Stringbase; existing
compatible Loque query builders can still supply the same public QueryIR.

Deon's upstream package lacks a prepare/prepack hook and omits source from its
package files. scripts/prepare-deon.mjs therefore fetches the exact public source
archive and builds the pure entry in the installed development dependency.
Loque's pinned Git artifact also omits its built entry; scripts/prepare-loque.mjs
builds its exact source revision. Root postinstall runs both through
prepare:dependencies. For an offline source build, STRINGBASE_DEON_SOURCE and
STRINGBASE_LOQUE_SOURCE can name local Git checkouts containing the exact commits;
git archive reads the committed trees and ignores working-tree changes.
No sibling checkout is modified. Internet access is needed for a clean default
install, as for the other dependencies.

Three precise source fixes are applied to that temporary Deon copy by
scripts/deon-compatibility.mjs, with exact-match assertions:

1. Keyword lookup checks own keys. Bare constructor/toString/__proto__ words must
   not resolve through Object.prototype and become invalid scanner token types.
2. Generated leaflinks carry a private Symbol marker. An ordinary user map with
   kind:'link' and name:'value' must remain a map, rather than becoming a link.
3. Escaped interpolation uses a private unpaired-surrogate marker, outside the
   valid UTF-8 value domain. The original NUL-delimited marker was valid user data
   and could silently turn into '#{'. Stringbase validates Unicode inputs before
   passing values to the serializer.

Integration tests cover these cases through insert, commit, close/reopen, and
query, including literal interpolation text and NUL-containing values. The
codec additionally checks every encoded database parses back unchanged before
replacement. The source fixes change no language syntax and touch no files in
the neighboring Deon repository.

Deon is bundled because the pinned upstream Git package cannot prepare itself
for production installation. Bundling both libraries is an evidence-based change from the original plan to
keep dependencies external: source preparation and pnpm's transitive Git policy
otherwise prevent a normal production installation. There is one Deon implementation, built
from its source; Stringbase does not maintain a duplicate parser or serializer.
The existing project LICENSE and LICENSE.deon cover the distributed package.

The optional @plurid/stringbase-mcp package has runtime dependencies on Stringbase
and the pinned official MCP SDK. It does not change the core package's
dependency-free installation. Both packed packages are tested in an isolated
production consumer, including a real SDK stdio connection and public types.

Before replacing these pins with registry releases, verify the API probes, remove
only fixes present upstream, and rerun the complete value corpus and isolated
tarball consumer tests. Do not silently fall back to the registry's older API.
Publishing Stringbase or either dependency is a separate release action.
