# Tracker milestone SDK example

```ts
import {
  DirectoryReleaseMilestoneStore,
  createReleaseMilestone,
  readReleaseMilestones,
  readTrackerReleaseSnapshot,
  resolveTrackerReleaseHistory,
  createChangelog,
} from "pm-changelog";

const tracker = ".agents/pm"; // A plain directory initialized with pm init.
const store = new DirectoryReleaseMilestoneStore(tracker);
const snapshot = await readTrackerReleaseSnapshot(tracker);
const milestone = await createReleaseMilestone(store, "autumn", snapshot, "tag:shipping");
console.log({ name: milestone.name, item_count: milestone.items.length });

const current = await readTrackerReleaseSnapshot(tracker);
const releases = await readReleaseMilestones(store);
const notes = createChangelog(resolveTrackerReleaseHistory(releases, current.items));
console.log(notes.markdown);
```

A database or remote SDK adapter can supply `{ capturedAt, items, doneItemIds }`
from its own consistent read and implement `ReleaseMilestoneStore`. Derive
`doneItemIds` through the SDK's capture-time status registry roles. The field is a
dense array of at most 100000 unique IDs present in the snapshot; query projection
keeps only selected IDs. Adapters omitting it use the SDK-default registry:

- `read(name)` returns the original complete milestone or `undefined`.
- `publish(name, milestone)` atomically inserts only if the name is absent and
  returns whether insertion won. Never update an existing name. Under the same
  transaction or writer lock, reject a new name whose capture time is not strictly
  later than every committed milestone; also reject case-folded name collisions.
- `names()` returns every committed release name.

Persist the compact render-input snapshot, not just the receipt. Pass untrusted persisted data
through `parseReleaseMilestone`; `readReleaseMilestones` does this automatically.
Creation projects tracker rows onto rendered fields and classification/ordering
inputs before JSON normalization and fingerprinting. Body, description, comments,
unrelated metadata and linked-record notes are omitted. Linked evidence retains
only path/command or delivery-state/reference fields. `--body-preview` is therefore
incompatible with milestone generation; use ordinary tracker generation for body
previews. Retained fields use JSON conversion of dates, custom `toJSON` values and
missing array entries.
Fingerprints detect accidental edits; they are integrity checks, not signatures
or authorization controls. The directory adapter publishes a fully written file
using an atomic hard link after syncing its data, then syncs the containing
directory before reporting success on POSIX. Windows skips directory syncing;
file data is still synced before publication. Storage must support hard links,
file syncing and, on POSIX, directory syncing; other backends need a transactional
adapter. If directory sync fails after publication, the call reports a storage
fault; retrying the same name safely recovers the existing verified snapshot.
Do not edit or delete milestone records to change notes.

SDK refusals are `ReleaseMilestoneError` values with typed `code` and `remedy`.
The host receives the same recovery guidance; standalone generation emits a
compact JSON error on stderr and exits nonzero. Codes cover invalid snapshots or
queries, changed membership, missing milestones, storage faults and conflicting
release-source options. A failed read never silently generates an empty release.

The resolver assigns an ID to the first milestone whose frozen eligibility
publishes it, using that milestone's frozen row. An earlier active capture reserves
no release membership. Until a done-role row is captured, a live closure remains Unreleased.
Later edits, reopenings and deletion cannot add to or rewrite an earlier release.

New milestone names use lowercase ASCII letters, digits, dots, underscores and
hyphens, excluding reserved device names. Existing case variants cannot create
separate releases. Capture times must be calendar-valid RFC 3339 timestamps with
an explicit `Z` or numeric offset, strictly later than all existing captures.
Backward or equal clocks refuse before publication; equal instants supplied to
the resolver also refuse rather than using name order as chronology.

The directory adapter serializes the final clock check and publication with
`.writer-lock`. It never steals a held lock. A prolonged lock becomes a recoverable
storage refusal; check for an active writer before investigating an abandoned
lock. Database adapters must enforce the same ordering inside their transaction.

## First publication ownership

`resolveTrackerReleaseLedger(milestones)` verifies and orders the whole
catalog by capture time, then binds each item to its first actually published capture and
original row. Generation and correction readers share this ledger; later edits,
recaptures and reopenings cannot move a published claim. Active, blocked and
canceled captures do not reserve publication. New schema-2 records include
fingerprint-bound `doneItemIds`; later status-role and alias changes cannot
reinterpret them. `readTrackerReleaseSnapshot` captures these IDs through the
SDK. The ledger's optional registry argument remains accepted for compatibility
but cannot affect historical decisions. Schema-1 records retain released
SDK-default status meaning and their exact original fingerprints, without rewrite.

CLI paths load current SDK roles only for live Unreleased items. SDK callers can
pass that registry as the third argument of `resolveTrackerReleaseHistory`.
The returned `statusSelection` and `statusRegistry` keep frozen and live meaning
separate. Admission, closure dispositions, neutral wording, category grouping,
breaking/semver decisions, counts and selection diagnostics share this context.
Custom done-role issues closed as duplicates or other non-changes are omitted;
issues without repair evidence remain neutral `Closed` entries. Canceled terminal
non-change dispositions are omitted too. An explicit `includeStatuses` overrides
admission only, including an empty list selecting every status; it never bypasses
closure evidence or reinterprets a frozen done-role row. Status IDs and aliases
are normalized through the same SDK-backed function on both sides of selection.
Diagnostics mark `filters.status_selection: per-item` when captured eligibility
overrides their fallback `filters.statuses` list.

For live SDK inputs, pass `statusRegistry: resolveRuntimeStatusRegistry((await
readSettings(tracker)).schema)` to generation, documents, summaries, audits,
audience contracts or consumer upgrades. Host commands load it automatically.
Standalone file/stdin inputs use SDK defaults unless `--pm-root` supplies the
tracker registry. No item status or stored row is rewritten for presentation.

Ownership uses `visibleChangelogItems`, the same selector used by Markdown,
structured documents and semver. Capture-time query selection, frozen done-role
eligibility, non-change dispositions and empty-title omission therefore agree.
An omitted capture owns nothing: a duplicate in v1 can be reopened and repaired,
then published exactly once in v2 and corrected there. Read-time presentation
filters narrow a view; they do not rewrite a release's captured publication.

`omittedNonChanges` on the ledger and `omittedNonChangeIds` on the returned history
context retain frozen omission diagnostics without granting release membership.
The history contains one row per item: a published claim takes precedence, then
live state, then omitted-only diagnostic rows. Later repairs remain selectable;
old omitted rows cannot shadow them or duplicate their IDs. Omission counts stay
available even after the same item publishes a repair. Pass the full history
context to generation, contracts and upgrade projections to preserve these counts.
