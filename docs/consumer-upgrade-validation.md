# Consumer upgrade validation

Read-only validation used the tracked public `unbraind/pm-changelog` project at
main commit `b3e5c9c`. A git archive supplied a plain scratch directory containing
only tracked project files, with no git repository. Tracker files and directories
were made non-writable; SDK and standalone CLI ran with a PATH containing no git
executable and a git ceiling above the scratch directory.

Reproduce with `node scripts/validate-consumer-upgrades.ts <copied-tracker>` after
`npm run build`. The script reads the supplied tracker and prints counts without
writing files. Use a public tracker copy, with all files and directories made
read-only, and an empty PATH with the Node executable invoked by its resolved
location. Do not point this validation at hosted or private project data.

| Measurement | Result |
| --- | --- |
| Certified complete input items | 196 |
| Closed items | 187 |
| Selected closed change items | 183 |
| Release groups | 36 |
| Existing facet declarations | 0 |
| Upgrade actions | 0 |
| Missing-action omissions | 0 |
| Already satisfied prerequisites | 0 |
| Compact JSON bytes | 148 |
| TOON bytes | 132 |
| Warm SDK elapsed | 529 ms |
| Files verified unchanged | 402 |

The selected operator interval was `(0.0.0,2026.10.25]`. This public corpus has
no authored facets: zero obligations is expected. Neither titles nor resolution
prose were interpreted as upgrade instructions. Zero missing-action omissions
means no breaking facets were declared; it does not certify consumer readiness.
Positive acceptance uses synthetic three-release fixtures with three actions,
duplicate publication, two prerequisite edges and exact CRLF preservation.

SDK and standalone compact JSON matched byte for byte; TOON decoded to the same
SDK report. The sorted before/after relative-path and SHA-256 manifest retained
all 402 files, with digest
`635922956aa8ce833d897114b488609ee6fdb7d9190d28ebbda00e0714509f81`.
The source public tracker was never modified. This is a single warm measurement,
not a hosted-backend, concurrency throughput or latency certification.

`test/consumer-upgrades.test.ts` supplies a fixed-seed reference-model test over
500 random operation sequences on one real non-git tracker. Each sequence writes
a fresh state, replays a prior input for that target, reapplies current state,
then repeats it. All 2,000 operations read persisted state back through the SDK,
including relationships, exact facet/action data and whitespace/CRLF variants.
Seeded native evidence includes files, tests, docs, annotations, resolution and
actual result; SDK readback checks those and lifecycle identity/timestamps against
the initial SDK snapshot while the reference model tracks every mutated field.
Body expectations use core `canonicalDocument`, never handwritten normalization.
After each operation both output encodings round-trip and a second complete SDK
read proves projection did not change native state. Random authored prerequisite
edges are checked against a simple independent reference ordering model, including
missing or out-of-range prerequisites. Every sequence also exercises JSON and
Markdown export both in memory and to a scratch file (2,000 exports total), then
reads complete state back through the SDK to verify preservation.

There is no new import/sync/apply path, journal, replay key or shared mutable state
to recover or interleave. Compilation and export are read-only projections;
native SDK mutation handles test setup. No package-owned lease or checkpoint is
introduced. Unit tests separately cover release boundaries, older prerequisites,
cross-audience references, cycles, conflicting definitions and inert shell-like
prose. Both installed command transports run with no git executable.
