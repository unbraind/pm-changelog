# Fleet CI v2

The required contexts are exactly `test (22)` and `test (26)`. PRs and manual
dispatch use GitHub-hosted Ubuntu with quick deterministic seed prefixes. Node 22 jobs have a 15-minute limit
and Node 26 jobs a 25-minute limit, each about three times measured execution. Superseded PR runs cancel. There is no push trigger on
this tier and no dependency on the exhaustive lifecycle job. CodeQL runs once
in its separate workflow; its table row lists triggers, not a matrix step.

| Check / contract | PR Node 22 | PR Node 26 | Docs/tracker-only PR (both) | Deep |
| --- | --- | --- | --- | --- |
| npm ci / merge driver preparation | yes | yes | yes | npm ci all jobs; prepare on matrix |
| Strict tracker health with exact legacy provenance baseline | — | yes | yes | both Node versions |
| Build + complete test suite | quick | quick via coverage | — | full, npm + Bun, Node 22/26 |
| Typecheck + test typecheck | via tests | yes | — | full release gates |
| Docstrings (no separate lint script exists) | — | yes | — | full release gates + lifecycle |
| Coverage: unchanged 100% lines, branches, functions and source inventory | — | quick | — | full, npm + Bun, Node 22/26 |
| Production audit | — | yes | — | full release gates |
| Pack dry-run + archive contents/privacy scan | — | yes | — | full release gates |
| Changelog consistency and link checks | — | yes | yes | full release gates + lifecycle |
| Release date + publish attestation verification | — | yes | — | full release gates |
| Committed dist matches fresh build, including untracked outputs | — | yes | — | Node 22/26 |
| Direct Bun CLI + SDK milestone runtime smoke | — | yes | — | Node 22/26 |
| Packed Bun project install + bunx CLI help | — | yes | — | full packed matrix in lifecycle |
| Registered correction + milestone pm test commands; credential-isolated focused suites | — | — | — | exhaustive lifecycle |
| Lifecycle behavioral reverts, agent-contract and itemless-pending reverts | — | — | — | exhaustive lifecycle |
| Packed correction acceptance: npm/Bun global + project, npx/bunx, 488 checks / 8 launchers | — | — | — | lifecycle |
| Public read-only tracker correction + agent-contract validation | — | — | — | lifecycle |
| CodeQL | separate workflow on matching paths | separate workflow on matching paths | filtered | main pushes on matching paths + weekly Monday 02:37 UTC |

Docs/tracker-only means every changed path matches `.agents/pm/**`, `*.md`,
`docs/**`, `CHANGELOG.md`, or `LICENSE`. Executable JS/TS files under the tracker
select code validation. NUL-safe PR endpoint comparison disables rename folding,
so a source deletion disguised as a move into documentation still selects code.
Node 22 keeps existing packaging fixtures inside its complete test suite, with
no separate coverage, changelog or pack command. The cheap path runs only npm ci,
tracker health and changelog consistency. Checks
remain present; the required workflow itself has no path filters.

Health invokes `pm health --strict-exit --require-merge-drivers`. This repository
already has 32 immutable legacy role records. The existing exact fail-closed
provenance baseline is retained; new warnings outside its advisory list fail.
This is checkout health, not a lossless merge attestation or a repair of history.

Deep runs on main pushes, daily at 01:53 UTC, and dispatch. This avoids the daily
release at 03:17, hourly reconciliation at :41, and weekly CodeQL at 02:37.
`deep (22)`, `deep (26)` and `lifecycle` each have a 120-minute timeout and share
per-ref cancellation. Each Node leg runs both npm and Bun full release gates.
`PM_TEST_DEPTH=full` and `PM_TEST_TIME_SCALE=3` apply to deep. The `pm-local`
self-hosted pool queues normally; only `PM_LOCAL_DEEP=off` selects hosted Ubuntu.
Changing the variable affects newly queued jobs, not existing queued jobs.

`test/support/depth.ts` uses the pilot's helper: quick is one tenth rounded up,
with a floor of 25 capped by the full count; unset, full and unknown values retain
full depth. Each quick corpus uses the same initial seeds, PRNG and assertions.
500 becomes 50; smaller 48/100/128 corpora become 25. Large input/limit fixtures
and finite Markdown cross-products retain their original sizes. Test titles
retain their full corpus names for registered proof selectors; diagnostics record
actual depth. Neither depth changes coverage thresholds or excludes sources.
Statement coverage remains independently unmeasured (pmc-ilrh).

The Node 26 npm release gate's pack verification checks archive contents; it does
not itself prove real Bun/bunx installations. Therefore the PR adds a packed Bun
project installation + bunx smoke and retains the direct Bun runtime smoke.
The exhaustive packed acceptance in lifecycle already proves npm/Bun global and
project installs, npx/bunx, SDK and host-extension behavior. Its outer process-tree
watchdog uses the pilot's tested async helper, with a 30-minute total budget
scaled by PM_TEST_TIME_SCALE; each individual command also uses the async
process-tree runner with a scaled three-minute budget. Expected CLI refusals
retain their captured stderr and use awaited rejection assertions. Each command
owns its process group; the outer watchdog gives the acceptance supervisor one
second to forward cancellation before hard termination. POSIX uses process-group termination and Windows
uses taskkill /T /F. Small process-tree fixtures verify deadline and cancellation.

Run 43623024195 failed five hostile container tests on CPU budgets of 1000ms:
Node 22 failed all five (1022–1345ms CPU); Node 26 failed four of them
(1035–1307ms CPU), with zero cancellations on either leg. Each case took about
3 seconds elapsed. CPU speed,
coverage instrumentation and contention made the fixed budget unreliable. Keep
the 50,000-element hostile inputs and every output assertion; scale CPU limits,
startup and operation watchdogs by PM_TEST_TIME_SCALE (default 1, deep 3).
Link-scanning latency and telemetry/proof cleanup guards scale likewise. These
ReDoS guards retain a time contract rather than claiming an operation-count proof.

Latest successful main run 43684138283: lifecycle 24m45s execution; Node 26
27m24s and Node 22 52m21s execution, each running two full gates. The slowest
successful corpus was native lifecycles at 442.6s, then correction sequences at
85.3s, consumer upgrades at 55.8s and agent-contract sequences at 44.2s. Owner's
24-hour baseline: 1,713 package runner-minutes, median successful PR CI 87 minutes.
Quick PR measurements and local validation receipts are recorded in the linked
Task and PR after the first run. Full depth is intentionally not run locally;
post-merge deep CI must certify the exhaustive gates on the chosen pool.

## Measured validation

Implementation head `fe5452d`, PR 358, CI run 43702407084:

| Required check | Created UTC | Started UTC | Completed UTC | Queue | Execution | Created to completed |
| --- | --- | --- | --- | --- | --- | --- |
| test (26) | 10:05:56 | 11:16:33 | 11:24:51 | 70m37s | 8m18s | 78m55s |
| test (22) | 10:05:56 | 11:34:16 | 11:39:07 | 88m20s | 4m51s | 93m11s |

All timestamps above are 2026-11-15. Both required checks passed. Node 22
build/tests took 4m40s; CodeQL passed in 55s of execution. Node 26 passed 1,146 tests, zero skipped
or canceled; coverage was 100% lines/branches/functions across the unchanged
30-source inventory. Its quick npm release gate took 7m51s, versus 13m36s for
one full npm gate in the historical main run. The native lifecycle corpus took
26.4s at quick depth, versus 442.6s at full depth in that historical run. Hardware
and host contention differ between observations; these are measured runs, not
a controlled benchmark. Real Bun project/bunx smoke passed in 3s.

Local static checks passed. The touched-suite run passed 305 tests and failed
one stale full-depth Unicode count assertion in 15m11s; exact per-string field
accounting then passed all three Unicode tests in 20.7s. The unchanged passing
tests were not repeated. Process-tree regressions passed 9/9 in 22.4s after
converting packed acceptance to async per-command deadlines. No full-depth
local run or extra local coverage run was started on the loaded host.

The fifteen-minute queue-inclusive target was missed before execution began.
Read-only fleet inspection found older hosted jobs running more than two hours.
`pmc-hosted-ci-queue` records the operational follow-up; package changes cannot
remove elapsed queue time. Other repository runs, variables and protection were
left unchanged. These receipts refer to the implementation head above; the PR
body records verification of the final source/evidence head separately.
