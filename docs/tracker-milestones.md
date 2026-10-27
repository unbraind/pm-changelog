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

A database or remote SDK adapter can supply `{ capturedAt, items }` from its own
consistent read and implement `ReleaseMilestoneStore`:

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

The resolver assigns an ID to the first milestone that captures it **closed**,
using that milestone's frozen row. An earlier open capture reserves no release
membership. Until a closed row is captured, a live closure remains Unreleased.
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

`resolveTrackerReleaseLedger(milestones, registry)` verifies and orders the whole
catalog by capture time, then binds each item to its first done-role capture and
original row. Generation and correction readers share this ledger; later edits,
recaptures and reopenings cannot move a published claim. Active, blocked and
canceled captures do not reserve publication. CLI paths load the tracker's SDK
status registry; SDK callers with custom statuses pass it to the ledger or as the
third argument of `resolveTrackerReleaseHistory`.
