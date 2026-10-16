# Open backlog verification

Baseline: `aafea5d` on main, package version `2026.10.15`. Items remain open
for orchestrator verification; a shipped fix does not require another runtime
change. Release tags below contain the cited commits. Registry reads confirmed
`2026.8.22`, `2026.10.4`, and `2026.10.12` are published.

| Item | Verdict | Current evidence |
| --- | --- | --- |
| pmc-4xu9 | Already fixed; stored-token remedy obsolete | `0ab4108`; `.github/workflows/release.yml:23,53,222,742` uses OIDC, upgrades npm, preflights identity and publishes with provenance. `test/release-workflow.test.ts:32` rejects stored auth. Included in `v2026.8.22`. No stored token should be restored. |
| pmc-3u78 | Already fixed | `ffe3bb5` plus later guard hardening through `49431c0`; `.github/workflows/release.yml:222` preflights before the version update at line 314, resumes untagged metadata, and `package.json:53` invokes the date verifier. `test/release-workflow.test.ts:379,563` covers preflight and recovery. Included in `v2026.8.22`. Identity acceptance is separate from npm's publish-action permission. |
| pmc-xndl | Still open; upstream implementation | Current caller `.github/workflows/pm-github-sync.yml:16` pins pm-github `2026.10.15` at `3015930b351a3d9c1c03ee4a26f8404025287df7`. That version's `index.ts:3904` still POSTs new exports without the planned issue state and does not persist the new issue link in that apply path. A newer pin alone does not prove the five limitations resolved. See design below. |
| pmc-ilrh | Still open; larger measurement change | `scripts/coverage-gate.ts:35,269` and `package.json:140` enforce lines/branches/functions only. There is no independent statement result. The inaccurate equivalence comment is corrected here; thresholds and measured inventory remain unchanged. See design below. |
| pmc-wf7n | Already fixed | `b00f3b2` in `v2026.9.8` removes the local scanner and imports/re-exports `pm-ops/attestation` by reference (`scripts/verify-release-publish-attestation.ts:35`). `d22b525` in `v2026.9.11` adds seven consumer bypass regressions. `test/verify-release-publish-attestation.test.ts:35,67` checks identity and refusal; no historical corpus count is claimed as a fresh run. |
| pmc-q22j | Already fixed; integration regression added here | `0f7cd3b` and `99d5879`, included in `v2026.8.22`. `package.json:48,57` passes `--date-from-version`; workflow lines 360-361 reuse the scripts and the direct release-note invocation also carries it. `test/verify-release-changelog-date.test.ts:206` checks actual tracked invocations. `test/release-backlog.test.ts` additionally executes the actual script arguments against a real tracker. |
| pmc-lnyt | Already fixed; integration regression added here | `50b84c5`, included in `v2026.8.22`. `src/release-context.ts:273` accepts numeric `-N` and validates the calendar date. `test/generator.test.ts:1729` rejects nonnumeric suffixes and impossible dates. The new built-CLI regression also asserts the suffix survives in the heading. |
| pmc-redos-startup-231 | Still open; larger harness change | `test/generator-redos.test.ts:9` still uses a 5000ms startup limit, separately from the 250ms parser CPU limit and 5000ms operation watchdog. Earlier load-sensitive readiness failures were not parser-budget failures. Passing gates do not invalidate that reproduction. See design below. |
| pmc-6eau | Already fixed | `a102d18` (#215), included in `v2026.10.4`. `src/release-context.ts:495` implements an inclusive ancestor boundary; `test/release-context.test.ts:158` owns its tree and plants a decoy package above the boundary. The adjacent tests cover inclusive and invalid boundaries. |
| pmc-fzs6 | Already fixed by the opt-in resolution feature | `d29b589` (#231), released in `v2026.10.12` as pmc-d3ds. `src/generator.ts:2060` selects `close_reason` only when requested and falls back to title. `test/entry-from.test.ts:49,84` covers default bytes, fallbacks, filters, and real trackers. Fleet-wide regeneration is not claimed by this backlog audit. |
| pmc-blj6 | Already fixed | `eab2d07` (#137), included in `v2026.8.9`. `.github/workflows/release.yml:568` attempts the SHA-guarded merge API independently of CLEAN/BLOCKED status. Only DIRTY/BEHIND abort immediately; thread resolution preserves human conversations. `test/release-workflow.test.ts:549` guards the retryable transaction. |

## Regression discrimination

All mutations below were applied independently and restored. The suffix probe
rebuilt `dist/` before testing the built CLI and after restoring the parser.

| Behavioral revert | Regression | Observed result |
| --- | --- | --- |
| Reject numeric `-N` in `calendarDateFromVersion` | `node --test test/release-backlog.test.ts` | Fails 0/1 with the calendar-version diagnostic for `2001.2.3-2`. |
| Remove `--date-from-version` only from `changelog:full` | Same command | Fails 0/1 on the heading date. |
| Remove `--date-from-version` only from `release:notes` | Same command | Fails 0/1 on the release-note heading date. |
| Make `findPackageJson` stop at filesystem root instead of the injected boundary | `node --test --test-name-pattern='throws when release-version-from-package finds no package.json' test/release-context.test.ts` | Fails 0/1 with a missing expected exception: it finds the fixture's decoy. |

Restored controls pass: built-CLI regression 1/1; the focused release-context,
release-workflow, attestation, and built-CLI group 63/63; existing suffix/date
validation tests 2/2. None skips a test or changes ambient ancestor metadata.

## Remaining designs

### pmc-xndl: upstream write-path acceptance

Keep the current gated import caller separate from export and project-sync
acceptance. In pm-github, use synthetic issues and a disposable project to
verify canceled-item selection, create-then-close export status, durable issue
provenance before repeat exports, resumable draft creation after a failed local
tag/status write, and pull-only default preference. Persist remote identities
before subsequent writes; retry from those identities instead of POSTing again.
Require a second apply with zero duplicates and fault injection at each remote
write/local receipt boundary. Adopt a published repair through the normal
dependency/caller update once its nonempty acceptance evidence exists. These
cross-system transitions exceed a small package-local change.

### pmc-ilrh: independent statement counters

Preserve the current source enumeration, type-only exemption verification,
and exact Node/V8 line/branch/function gate. Add a separately instrumented
statement-counter run over the same authored TypeScript inventory, with source
maps verified against emitted JavaScript. Report covered/total statement
counts and require exact 100%, independently of the line result. Negative
fixtures must include two executable statements on one line with only one
executed, an unimported source, an executable exemption, and a lowered statement
threshold. Validate Node 22 and 26 and document tooling compatibility before
choosing the instrumentation dependency. This requires new measurement and
policy coverage, beyond a 100-line repair; renaming line coverage is insufficient.

### pmc-redos-startup-231: startup readiness and lifecycle

Extract the child-process harness into a test utility with distinct bounded
startup, ready-to-command, and operation phases. Keep the 250ms parser CPU
budget, every hostile input, and an independent finite operation watchdog.
Choose and document a separate startup allowance using controlled loaded and
unloaded runs; never retry or reset the operation CPU measurement to hide a
parser failure. Add deterministic delayed-readiness, never-ready, worker-error,
CPU-overrun, and post-ready hang cases. On every exit path terminate and await
the child before resolving, so a timed-out probe cannot overlap the next one.
Keep the full suite and coverage run as acceptance alongside the loaded/unloaded
comparison. The lifecycle refactor and its negative controls exceed a small
timeout edit; raising the single constant alone would leave them unverified.
