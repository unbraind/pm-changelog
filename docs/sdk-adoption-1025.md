# SDK completeness adoption evidence

Tracked by [pmc-sdk-completeness-1025](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-sdk-completeness-1025.toon), related to the earlier [pmc-0jm1 SDK adoption](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-0jm1.toon).

| Audit finding | Disposition | Evidence |
| --- | --- | --- |
| Duplicate whole-tracker incompleteness diagnostics at audit `src/generator.ts:988-998` (alongside certification at `:908`) | Delete `incompleteListAllSignals`; use `inspectCompleteListResult` and `certifyCompleteListResult` in `parseListAllItemsJson`. Request strict, unbounded source reads. | `test/sdk-completeness.test.ts`, existing generator receipt tests, public-tracker differential below |
| Intentionally filtered caller release selections | Keep caller scope adaptation in `parsePmItemsJson`; its delivery invariants already use the SDK. | `test/input-completeness.test.ts` and filtered-scope assertions in `test/sdk-completeness.test.ts` |
| Immutable milestone files at audit `src/milestones.ts:242` | Already use `listAllComplete`; files are release artifacts, not duplicated item/history storage. No replacement applies. | Existing milestone tests; no milestone implementation changes |

No missing SDK API blocks this adoption. Dependency pins and coverage thresholds stay unchanged.
The documented stricter SDK findings and legacy receipt differences are in [usage](usage.md).

## Public-tracker differential

The baseline is an independently compiled `origin/main` tree at
`fa8a8a1d0af97797e6a34a78bdd6b9b30242378e`.
The probe runs both builds on non-git copies extracted only from tracked public
repository artifacts. Original tracker files are chmod read-only and SHA-256
checked afterward. Derived runtime caches may be created separately. Probe
processes have an empty `PATH` and `GIT_CEILING_DIRECTORIES` set above each copy;
there is no git executable on the command path. Public repository visibility
was checked before publishing evidence.

| Public source | Snapshot commit | Items | Unchanged original artifacts | Function result | CLI comparisons |
| --- | --- | ---: | ---: | --- | ---: |
| pm-changelog | `fa8a8a1d0af97797e6a34a78bdd6b9b30242378e` | 197 | 404 | byte-identical | 3/3 |
| pm-ops | `36478d717b40a5f73a49b06b486c1c83f93d39bc` | 154 | 316 | byte-identical | 3/3 |
| pm-context | `9068fb15ae8c0fd03aa004e00e8e6341af8387cb` | 92 | 191 | byte-identical | 3/3 |

Compared functions: `readPmItems`, `parseListAllItemsJson`, caller-filtered
`parsePmItemsJson`, and `createChangelog`. Compared CLI outputs: Markdown,
structured JSON, and summary JSON, with explicit version/date. All comparisons
use exact serialized output equality. Total: 443 items, 911 unchanged source
artifacts, nine identical CLI outputs; no intentional difference on valid
complete fleet reads.

Reproduce with an independently compiled baseline tree and tracker snapshots:

```bash
node test/sdk-adoption-differential.ts BASELINE_BUILD CHANGELOG_TRACKER_SNAPSHOT OPS_TRACKER_SNAPSHOT CONTEXT_TRACKER_SNAPSHOT
```

This is a standalone integration proof, separate from the release suite so
normal package tests do not depend on adjacent checkouts or an older build.
The script prints item/artifact counts and output SHA-256 digests, not tracker
content.

## Behavioral revert proof

Restore only the baseline `parseListAllItemsJson` and its deleted helper,
retain the new strict argv, and rebuild. Then run:

```bash
node --test test/sdk-completeness.test.ts
```

Result with the replacement reverted: exit 1, 18 reported tests, one pass and
17 failures (16 receipt subtests plus their parent). Each receipt subtest
reports a missing expected exception. Restoring the SDK replacement and
rebuilding makes all 18 pass. This isolates the SDK contract replacement from
the source-read flags. The revert procedure and results are also recorded on
the tracker item.

The one independent passing witness in the reverted run primes `listAllComplete` and the `listMutationEvents` derived event index,
then corrupts a history hash, freshly calls `readHistoryEntries`, and confirms
`verifyHistoryEntries` refuses it. The replaced code did not verify or read
item history, and no cached history event index is introduced. Completeness
certification is not a history-integrity claim.

Targeted validation:

```bash
npm run typecheck
npm run build:test
node --test test/sdk-completeness.test.ts test/full-projection.test.ts test/input-completeness.test.ts
```

The targeted suite passes 81/81, including the corruption witness, and is linked
and executed through `pm test`. Focused existing generator checks pass 24/24.
There is no lint script in this package; `git diff --check` validates whitespace.
The release gate measures lines, branches and functions at 100%; independently
measured statement coverage remains the pre-existing `pmc-ilrh` scope.

## Full local release gates

Candidate commit: `c32b883`. Both gates ran with isolated HOME and system/global
Git configuration disabled. npm used the package worktree; Bun used a separate
clean checkout of that same commit so coverage reports could not collide.

| Command | Tests | Skipped | Lines / branches / functions | Result |
| --- | ---: | ---: | --- | --- |
| `npm run release:check` | 852/852 | 0 | 100% / 100% / 100% | pass |
| `bun run release:check` | 852/852 | 0 | 100% / 100% / 100% | pass |

Local runtimes: Node 24.19.0, npm 11.17.0, Bun 1.3.5. The coverage presence
gate requires 22 source files; the separate docstring gate checks 201 declarations
across 26 files. Both release gates also passed production audit, package dry
run, changelog/link checks, version-derived release dates and publish-attestation
validation. No dependency or threshold changes were needed. Clean-checkout
health meets the existing CI warning policy. CI repeats the full npm and Bun
gates under Node 22 and 26 on the final PR head.
