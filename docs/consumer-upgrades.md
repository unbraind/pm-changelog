# Consumer upgrade obligations

Audience contracts own publishing prose and attribution. Core Plan owns step
shape and lifecycle; core relationship analytics owns ordering. This package
projects explicit release declarations into pending Plan step data. It adds no
workflow engine, persisted Plan, executor, import, sync, retry journal or shared
mutable state. Existing changelog export remains a read-only publication path.

```ts
import { buildConsumerUpgrades, formatConsumerUpgrades } from "pm-changelog";
import type { ChangeFacet, PmItem, UpgradeAction } from "pm-changelog";

const prepare: UpgradeAction = {
  id: "prepare", title: "Prepare configuration", requires: [],
};
const actions: UpgradeAction[][] = [
  [prepare],
  [prepare, { id: "migrate", title: "Migrate configuration", requires: ["prepare"] }],
  [{ id: "restart", title: "Restart service", requires: ["migrate"] }],
];
const items: PmItem[] = actions.map((upgrade_actions, index) => {
  const facet: ChangeFacet = {
    audience: "operator", text: "The configuration contract changed.",
    breaking: true, upgrade_actions,
  };
  return {
    id: `example-${index}`, title: "Delivered configuration change",
    type: "Feature", status: "closed", release: `${index + 2}.0.0`,
    change_facets: [facet],
  };
});
const report = buildConsumerUpgrades({
  items, audience: "operator", from: "1.0.0", to: "4.0.0",
});
console.log(formatConsumerUpgrades(report, "json"));
// action_count: 3; steps: prepare, migrate, restart, each once.
// Every step has order: 1..3 and status: "pending" (core Plan semantics).
```

Persist facets through the active extension's native SDK `runCreate`/`runUpdate`
`field: ["change_facets=" + JSON.stringify(facets)]`, or CLI `--field` with that
same JSON value. Audience contract output stays compatible: it publishes only
the explicit text/source and shared attribution ledger, without action prose.

`UpgradeAction` reuses core Plan `id`, `title` and optional `body`; `requires`
contains audience-wide action IDs. There is no command field. Title/body retain
exact authored whitespace, including CRLF, and remain inert even when they look
like shell commands. Unknown fields and malformed declarations refuse. A facet
may use `source: "close_reason"` instead of `text`; actions still require explicit
authorship. A breaking facet without actions produces a `missing_actions`
omission when its release is in range. Ordinary facets create no obligations.

The interval is `(from,to]`. Specify stable numeric release triplets, optionally
prefixed with `v` or suffixed with a numeric daily disambiguator, for example
`2026.10.24-1`. Comparison reuses the package's release comparator. Unsupported
prereleases/build metadata, ambiguous or unpublished release attribution and
reversed/empty intervals refuse. Every selected breaking facet requires an
explicit `release`; timestamps and milestone names do not infer a version.
Only closed change items selected by existing closure/audience policy contribute.

Repeated IDs must have identical title, body and prerequisite sets; their earliest
publication determines applicability. Order and duplicates within `requires` do
not change the definition. The step retains all distinct source item/release
attributions through the target version, in canonical item-ID order.
Dependencies introduced at/before `from` are reported in
`satisfied_prerequisites`, treating the installed version as the baseline; their
earlier dependency closure is not re-executed. Every other prerequisite must be
declared for the selected audience and published by `to`. No foreign audience
prose or native item relationship becomes an action or prerequisite.

Core `RelationshipGraph` and `analyzeRelationshipExecution` determine dependency
order. Independent steps use core's deterministic ordering. Selected self-edges
and cycles refuse; no partial plan is returned. Conflicting audience-wide IDs
refuse even outside the selected interval, so authors cannot silently redefine
an obligation between releases.

Catch `ConsumerUpgradeError` for stable codes `invalid_upgrade_options`,
`invalid_upgrade_actions`, `ambiguous_upgrade_action`, `missing_prerequisite`,
and `upgrade_cycle`, with `remedy` and a nonzero expected-error exit code.
Existing `AudienceContractError` handles invalid audiences/facets/item identity.
The standalone CLI emits `{error:{code,message,remedy}}`; the host retains core's
expected-error presentation and next steps.

There is no execution or recovery state, revision-bound idempotency key, claim,
lease, outbox or checkpoint in this projection. Recompile against current SDK
reads when source declarations change. A caller that later creates or executes
a Plan must use core's revision and lifecycle controls; this report is neither
an execution receipt nor proof that a consumer completed an upgrade.

Both transports work in a plain tracker directory with no git executable.
No network or subprocess is needed for compilation. The public-tracker check
is read-only and includes a before/after file-hash manifest. The seeded model
test reads persisted fields and relationships back through the SDK after each
operation and checks JSON/TOON round trips without handwritten normalization.

Unicode text uses explicit U+FFFD replacement for each lone UTF-16 surrogate.
Valid pairs (including emoji), combining sequences, whitespace and CRLF remain
unchanged. Obligation assumptions, command/evidence strings, audience notes and
upgrade title/body fields use this policy at their shared producer boundary.
Native item IDs and release/section attribution use the same policy in reports;
IDs that collide after replacement refuse rather than merge unrelated items.
JSON and TOON output apply the same replacement to every remaining string leaf
and dynamic key, including legacy native metadata. Ambiguous keys refuse with
`UnicodeOutputError` (`invalid_unicode_output`, field `object key`) and a remedy.
The policy affects projections only: tracker data, historical snapshots, digest
inputs and signed correction records are not rewritten. Signed corrections keep
their existing strict validation and typed refusals for malformed new values.
