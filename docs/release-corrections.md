# Correct a published release claim

Requires pm-cli 2026.10.23 or newer for the typed transaction and complete-read SDK surface.

A release milestone freezes the published item title and membership. A later factual
correction adds a linked assertion; it never edits that snapshot or replaces a
historical changelog entry. Claim auditing remains the pre-publication check.
Source-fragment validity belongs to pm-evidence; native context events, history and
transaction coordination belong to the pm SDK.

```sh
pm changelog corrections view --release v1 --item example-claim --format json
pm changelog corrections append --input correction.json --format json
```

The standalone equivalents are `pm-changelog corrections view` and
`pm-changelog corrections append`, with optional `--pm-root`. TOON is the default;
`--json` or `--format json` selects compact JSON. Append returns
`{changed,correction}`; view returns the immutable original, current wording,
revision, full linked chain and counts of skipped foreign, invalid and unrelated
annotations. A refusal exits nonzero with a typed code and remedy.

A claim belongs to its **first actually published capture in chronological order**.
An earlier active/blocked/canceled, non-change, query-filtered or empty-title capture does not publish it and reserves no ownership. A later repair belongs to the first eligible release that actually renders it. Later recaptures,
live wording edits and reopenings do not transfer ownership. View and append
refuse a later snapshot with `correction_missing`; select the original release.
Generation and correction commands use the same verified catalog ledger. New
schema-2 captures freeze SDK-classified `doneItemIds` in their fingerprint;
changing status roles or aliases later cannot move ownership, change historical
wording, hide a correction, or change its replay identity. Schema-1 records retain
the released SDK-default status meaning and their original fingerprints.
SDK history callers can pass the current registry as the third argument to
`resolveTrackerReleaseHistory` for live Unreleased items only. Its per-item
`statusSelection` preserves frozen eligibility; explicit `includeStatuses` or CLI
status filters still take precedence. Selection diagnostics use the same rule.
Explicit filters change admission, never closure evidence: non-change
dispositions are omitted for every terminal status, and neutral issue closures
cannot become fixes or breaking changes. A non-change capture is not a published
claim target; correction view/append refuse it with `correction_missing` before
writing. Native annotations and historical snapshots remain intact.

Use the view's `milestone` and `revision`. For the first correction use an empty
`supersedes`; subsequently use the last correction's `id`.

```json
{
  "schema": 1,
  "release": "v1",
  "item": "example-claim",
  "milestone": "<64 lowercase hex characters from the current view>",
  "id": "accuracy-1",
  "supersedes": "",
  "expectedRevision": "<revision from the current view>",
  "wording": "The measured npm acceptance covered two installation modes.",
  "evidence": ["docs/acceptance.md#installation-results"]
}
```

IDs are 1–80 letters, digits, dots, underscores, colons or hyphens, starting with a
letter or digit; release names also follow milestone naming rules. Published and corrected wording must be
nonblank valid Unicode up to 4000 UTF-16 code units. Evidence contains 1–16 nonblank references of
at most 512 characters each. Arrays must be dense and have no extra properties.
Unknown fields, malformed Unicode, unsupported control characters and incorrect optional `revision` hashes refuse.
Prose, including CRLF and surrounding whitespace, is preserved exactly. JSON input
must be a regular UTF-8 file of at most 128 KiB. No evidence reference is fetched or
executed. Keep public corrections free of private data.

```ts
import {
  appendReleaseCorrection, readReleaseCorrectionView,
  formatReleaseCorrection, parseReleaseCorrection,
} from 'pm-changelog';

const view = await readReleaseCorrectionView(pmRoot, 'v1', 'example-claim');
const receipt = await appendReleaseCorrection(pmRoot, {
  schema: 1, release: view.release, item: view.item, milestone: view.milestone,
  id: 'accuracy-1', supersedes: view.chain.at(-1)?.id ?? '',
  expectedRevision: view.revision,
  wording: 'The measured npm acceptance covered two installation modes.',
  evidence: ['docs/acceptance.md#installation-results'],
}, { author: 'release-agent' });
const exported = formatReleaseCorrection(receipt.correction, 'json');
parseReleaseCorrection(JSON.parse(exported)); // exact re-import is a no-op
```

The optional `milestones` adapter supports non-directory immutable milestone
storage. Item operations always use the supported pm SDK; SDK acquisition never
walks launcher paths or symlinks. Native structured notes store immutable, versioned, content-verified
correction envelopes and core history retains their provenance. Do not edit or
delete correction events: append a new correction. Foreign discussion and
malformed envelopes are counted and skipped independently, without hiding other
valid corrections. A view is bounded to 256 corrections and 10000 annotations per
claim; publish a new claim when those bounds are reached.

An identical replay, including an older correction after later appends, returns
`changed: false`. A reused ID with different facts refuses
`correction_conflict`; an ancestor superseding itself or a descendant refuses
`correction_cycle`. Stale predecessor IDs or revisions refuse `correction_stale`.
Read and review the latest view before creating a new correction. Transaction
identity includes the milestone, item and expected predecessor revision. Recovery
re-reads SDK state rather than blindly applying saved input. Cooperating writers
serialize under the SDK workspace transaction lease; native context-event locking
owns the append. A peer's completed identical correction is reported as unchanged.

Historical `generate --milestones` remains byte-identical. Current corrections are
an explicit separate view: consumers choose whether to display them beside the
original wording. This feature corrects published item-title claims; it does not
rewrite arbitrary Markdown or infer corrections from live item edits.

## Without git

Append, view, JSON/TOON serialization, recovery and immutable milestone generation
work in a plain-directory tracker without git installed. The same SDK item
primitives own durable history. Tag-based release generation still requires a git
repository.
