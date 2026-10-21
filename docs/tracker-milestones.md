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
  returns whether insertion won. Never update an existing name.
- `names()` returns every committed release name.

Persist the full snapshot, not just the receipt. Pass untrusted persisted data
through `parseReleaseMilestone`; `readReleaseMilestones` does this automatically.
Fingerprints detect accidental edits; they are integrity checks, not signatures
or authorization controls. The directory adapter publishes a fully written file
using an atomic hard link after syncing its data, then syncs the containing
directory before reporting success. Storage must support hard links and file
and directory syncing; other backends need a transactional adapter. If directory
sync fails after publication, the call reports a storage fault; retrying the same
name safely recovers the existing verified snapshot. Do not edit or delete
milestone records to change notes.

SDK refusals are `ReleaseMilestoneError` values with typed `code` and `remedy`.
The host receives the same recovery guidance; standalone generation emits a
compact JSON error on stderr and exits nonzero. Codes cover invalid snapshots or
queries, changed membership, missing milestones, storage faults and conflicting
release-source options. A failed read never silently generates an empty release.

The resolver keeps the first captured closed row for each ID, including closures
first observed in a later milestone. That completion stays under the first
milestone containing the ID even if the current tracker reopens or deletes it.
Until a closed row is captured, a selected open member can use its live closure.
