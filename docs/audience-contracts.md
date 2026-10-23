# Audience-specific change contracts

Facets live in core item metadata as the optional `change_facets` array. With
pm-changelog installed as a trusted extension, core owns field mutation, validation,
history and storage. For example, annotate an existing delivered item:

```sh
pm update demo-cache --field 'change_facets=[{"audience":"api-user","text":"Responses include a cache revision."},{"audience":"operator","source":"close_reason"},{"audience":"agent-behavior","text":"Refresh context when its revision changes."}]'
pm changelog contracts --group-by release --audience api-user --format json
pm-changelog contracts --pm-root .agents/pm --group-by release --format toon
```

Each declaration must name `api-user`, `operator` or `agent-behavior` and contain
either a nonblank `text` string or `source: "close_reason"`. The latter opts that
audience into the item's existing resolution prose, with the same single-line
normalization as ordinary changelogs. Titles, bodies, other resolutions and other
audiences' notes never supply fallback text. Extra fields, unknown audiences,
malformed facets and ambiguous IDs refuse with a stable code and remedy.
Repeated notes are deduplicated and sorted by code units; exact text preserves
embedded newlines. Omit `--audience` to produce all three contracts in canonical
API-user, operator, agent-behavior order.

```ts
import {
  buildAudienceContracts, readAudienceContracts, formatAudienceContracts,
  AudienceContractError,
} from "pm-changelog";
import type { ChangeFacet } from "pm-changelog";

const facets: ChangeFacet[] = [
  { audience: "api-user", text: "Responses include a cache revision." },
  { audience: "operator", source: "close_reason" },
];
const report = buildAudienceContracts({
  groupBy: "release",
  audience: "api-user",
  items: [{
    id: "demo-cache", title: "Cache defect", type: "Issue", status: "closed",
    release: "2.0.0", close_reason: "Fixed cache refresh; merged PR #42",
    change_facets: facets,
  }],
});
console.log(formatAudienceContracts(report, "json"));

// Backend-aware complete metadata read; works in a plain tracker directory.
try {
  await readAudienceContracts(".agents/pm", { audience: "operator" });
} catch (error) {
  if (error instanceof AudienceContractError) console.error(error.code, error.remedy);
  throw error;
}
```

For this example, the API-user contract contains only `Responses include a cache
revision.` and references ledger row zero. The operator sees only the explicitly
requested `Fixed cache refresh; merged PR #42`. The agent-behavior contract has no
notes and an omission `{attribution: 0, reason: "missing_facet"}`. Removing
`close_reason` gives the operator a `missing_resolution` omission instead.

Every report includes `schema_version: 1`, `ledger_sha256`, `item_count`,
`note_count`, `omission_count`, `ledger` and `contracts`. Each ledger row contains
only the canonical item ID, release heading and section heading. Each note and
omission references that shared ledger by zero-based `attribution`. The fingerprint
is SHA-256 of the UTF-8 JSON serialization of the ledger. The ledger is identical
across audience projections of the same selection; it carries no note text or
tracker title. TOON stores the ledger once and uses compact tables; JSON uses one
unindented object and a trailing newline. Neither format includes a generation
clock. Counts describe the requested audience projection.

TOON uses the `@toon-format/toon` 4.4.0 encoder, matching the pinned pm CLI.
Control characters such as form feed, backspace, NUL and unit separator use
TOON-compatible Unicode escapes; quotes, backslashes and line breaks round-trip
through the same decoder exposed by the pm SDK. JSON encoding remains separate.

Only closed items pass selection. Existing non-change closure exclusions, release
and milestone grouping, and section rules remain authoritative. `--group-by`
accepts `version` (default), `release` and `milestone`; `--section-by` accepts
`category` (default), `type`, `status` and `label`. `--release-version` sets an
explicit version heading. SDK callers can also supply the generator's time windows,
release membership, tag exclusions and release limits. Immutable milestone items
freeze the ordinary changelog fields; current audience declarations must come
from a complete core metadata read or an explicitly supplied item set.

No git executable, repository, external process, model, inference or network is
needed by the contract path. Both commands read through core `listAllComplete`,
including its all-status/full/strict/unbounded completeness certificate, so truncated
or partial trackers cannot silently become publishable contracts. Successful
commands write only stdout. They never write a changelog or mutate source items.
Expected refusals exit nonzero; standalone stderr includes `error.code`,
`error.message` and `error.remedy`. Core read failures retain the SDK's own typed
completeness receipts. This publishes author-declared delivery notes; it does not
independently verify deployment, test success or the truth of declared prose. Use
`pm changelog audit` for recorded claim-evidence support.
