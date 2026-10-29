# Agent contract drift index

`pm changelog drift --from 1.0.0 --to 10.0.0 --format toon` returns explicit
agent obligations that changed in `(from,to]`. Both boundaries are required.
The baseline is the latest declared state at or before `from`; all intervening
changes are retained, even if a later release restores an earlier assumption.

The index compares **declared coverage**. It does not infer meaning from release
notes, inspect installed CLI contracts, check deployments, execute commands or
write tracker state. Missing declarations never imply removals or unchanged
behavior. Include the complete history of declarations to establish a baseline;
`complete` means no malformed/missing declarations were encountered in this
input, not that every behavior of the package was declared.

## Declaration example

Authors add `obligations` to an existing `agent-behavior` change facet:

```json
{
  "audience": "agent-behavior",
  "text": "Retrying agents must re-read the current target revision.",
  "obligations": [
    {
      "id": "retry.target-revision",
      "assumption": "Read the current target revision before every retry.",
      "commands": ["pm example apply", "pm example recover"],
      "evidence": ["example-revision-guard", "test-retry-interleaving"]
    }
  ]
}
```

Persist this through the host's registered `change_facets` field. The item must
have a configured **done role** and a numeric release (for example `2.0.0` or
`2026.10.28-1`). The existing generator owns release metadata fallback and
non-change closure selection. Active, blocked and canceled roles do not publish
obligations. No status-name heuristics are added.

An obligation ID is stable, package-wide, case-sensitive and at most 160 UTF-8
bytes, matching `[A-Za-z0-9][A-Za-z0-9._:-]*`. Active records have exactly `id`,
`assumption`, `commands`, `evidence`. Assumptions preserve whitespace and CRLF
exactly, up to 8192 UTF-8 bytes. Commands and evidence are sorted unique sets of
1–64 nonblank strings, each up to 256 UTF-8 bytes. Command names are inert text.
Evidence IDs are author-supplied references, not independently verified proof.

A release explicitly retires an obligation with a tombstone:

```json
{"id":"retry.target-revision","removed":true,"evidence":["example-retired-retry"]}
```

Omitting an ID from a later release leaves its prior declaration in effect.
Changing only evidence produces an unchanged reference with fresh provenance.
Changing the assumption or command set produces a `changed` transition. A
retired ID declared again is `added`. A removal without an active baseline is
an `orphan_removal` omission. Identical declarations in one release combine
provenance; conflicting declarations refuse because their order is ambiguous.

## SDK and compact output

```ts
import {
  parseAgentObligation, buildAgentContractDrift,
  readAgentContractDrift, formatAgentContractDrift,
} from "pm-changelog";

const declaration = parseAgentObligation({
  id: "retry.target-revision",
  assumption: "Read the current target revision before every retry.",
  commands: ["pm example apply"], evidence: ["example-revision-guard"],
});
// A pure build accepts complete native SDK metadata and optional statusRegistry.
const report = await readAgentContractDrift(".agents/pm", {
  from: "1.0.0", to: "10.0.0",
});
console.log(formatAgentContractDrift(report, "toon"));
```

The SDK uses the supported `@unbrained/pm-cli/sdk` public import and certified
`listAllComplete` read. It never resolves the SDK through executable paths or
symlinks. Host extension and standalone CLI use the same projection.

`definitions` stores each unique `{id, assumption, commands}` once. Zero-based
`ref`, `before`, and `after` indexes refer to that table:

- `baseline`: active declarations at `from`, with release, item IDs and evidence.
- `changes`: `added` (`before:null`), `removed` (`after:null`), or `changed` (both
  indexes), with release, obligation ID, item IDs and evidence IDs. Follow the
  definition indexes for the affected commands and old/new assumptions.
- `unchanged`: references with observation release, item IDs and evidence,
  without repeated assumptions or command lists.
- `omissions`: individual bad records, legacy prose-only facets, nonnumeric
  releases and orphan removals. Valid sibling records continue. `complete:false`
  makes these gaps visible; no ordinary titles, bodies or notes are copied.

JSON is compact and newline-terminated; TOON uses tables and preserves exact
strings. All numeric indexes are finite safe integers checked before formatting.
There are at most 100000 input items and 100000 facets plus declarations combined, 256 facets per item
and 256 obligations per facet. Arrays must be dense. Stable numeric releases have
safe-integer components; ranges, prereleases and build metadata are refused.
A request above these bounds refuses instead of truncating silently.
Merged evidence is bounded by the input domain: at most 6400000 IDs (100000
scanned records times 64 IDs per declaration), rather than the single-record or
record-count bound. Item-level and record-level omissions together permit up to
200000 rows. Native item IDs retain the SDK's domain instead of acquiring a new
publication-only byte limit. Every orphan-removal contributor keeps its own item
and facet/obligation coordinates.

Known numeric releases after `to` are excluded before reading or validating their
facets and before charging facet/declaration budgets. Release identity uses the
generator's heading normalization, so dated headings such as `3.0.0 - 2026-10-29`
and bracketed headings obey the same bound in stored releases and SDK
`releaseWindows`. Stored numeric padding also follows generator identity:
`v2026.06.07`, `2026.6.7` and `[2026.06.07] - 2026-06-07` describe the
same release, including when seeding a baseline or excluding future metadata. Range arguments remain bare canonical numeric versions (for example `2026.6.7`). They cannot introduce
omissions, ambiguities or schema refusals into an earlier report. Unknown legacy
release headings still produce their documented omissions. Consumer upgrades use
the same early temporal selection through the audience SDK's optional inclusive
`untilVersion` bound (requires `groupBy: "release"`); unbounded audience
publication retains its existing rules.

`AgentContractDriftError` extends core `PmCliError`. Codes
`invalid_drift_options`, `invalid_obligation`, `ambiguous_contract` and
`invalid_drift_report` include actionable `remedy` and nonzero exit semantics.
Standalone refusals render `{error:{code,message,remedy}}`; the host preserves
its standard expected-error rendering. Bad individual declarations appear as
omissions rather than failing the entire item.

## Without git

Both commands and all SDK projections work in plain directory trackers, including
with a PATH containing no git executable. This feature has no import, apply,
sync, journal, checkpoint, idempotency key or mutable shared package state.
It does not use `commitWorkspaceTransaction` or claim snapshot/lock isolation:
ordinary SDK writers can interleave with the complete read and the settings read.
The report describes the input read, not an atomic multi-writer snapshot. Retry
after writers settle when that distinction matters.

## Verification

The ten-release fixture proves baseline seeding, five transitions (including
removal and reintroduction), restored assumptions and unchanged references, with
both output encodings smaller than the concatenated notes. Seed `0x6dc1f7`
runs 500 model sequences through real non-git SDK state, each with current input,
an older replay, then current input, including CRLF, native fields, relationships,
ambient focus and custom status roles. A separate seed `0x9a71c` checks 500
randomly generated custom status registries against an independent role model.
Every projection/serialization is followed
by an SDK state read to detect accidental mutation. Legacy facets remain readable.
`test/agent-contract-drift.test.ts` also fuzzes dense arrays, extreme values and
output references, and checks host/standalone/SDK parity without git.

The regression suite covers 100032 merged evidence IDs across every transition,
150000 combined omissions, long native IDs, exact orphan coordinates and 500
unrelated future-metadata variants. It also rejects arrays above the derived
output bounds. The self-contained function-only revert helper
mutates only disposable copies and does not require retained git history; SDK and CLI execution
remain independent of git. Packed acceptance exercises the same cases through
npm/Bun global and local installs, npx and bunx.
