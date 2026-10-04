# PM CLI/SDK 2026.10.4 certification

PM item: [pmc-38z4](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-38z4.toon).

Exact development pins: `@unbrained/pm-cli` and `pm-ops` 2026.10.4, `@types/node` 26.6.4, `typescript` 7.0.2, `typescript5` alias `npm:typescript@5.9.3` (the script requires its parser API). Runtime floors remain unchanged. Dependabot #214, #216, #217, #218 are consolidated, including CodeQL is advanced from Dependabot #214 to newer SHA `2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2` with its exact `# v4.38.2` comment (also present in pm-slack-standup Dependabot #103).

The launcher is copied byte-for-byte from `node_modules/pm-ops/templates/prepare-merge-driver.ts`. A real file in `NODE_PATH` exercises the new inconclusive filesystem-probe refusal. Two integration fixtures now pack their built distribution with `npm pack --ignore-scripts --pack-destination <fixture>` and install that archive, preserving activation, doctor and output assertions while avoiding incomplete checkout scans.

## Security and health

The repository's open Dependabot alerts response was `[]`. Both `npm audit --omit=dev` and `npm audit` report `found 0 vulnerabilities`. `npx pm health --json --require-merge-drivers` reports `ok: true`, with only the unchanged CI baseline `provenance_value_domain_invalid:claude-code:role:single_digit:32`.

## Full gate

Command: `flock /tmp/claude-1000/heavy-gate.lock npm run release:check`.

The first run exposed two incomplete-local-install fixtures (524/526 passed) and the newly shipped launcher branch lacked coverage. The corrected full gate passed: 527/527 tests, zero skipped; 100% measured lines, branches and functions across 12 sources; 158 documented declarations. Production audit, pack contents, generated changelog, release-date and publish-attestation checks passed. Focused packed-install and real filesystem acceptance passed 3/3. Independent statement coverage remains unmeasured and tracked by `pmc-ilrh`; no threshold or exclusion changed.

## Packed real-tracker dogfood

`flock /tmp/claude-1000/heavy-gate.lock /tmp/claude-1000/cert-wt/dogfood-changelog.sh` packed the package with `npm pack`, installed its archive and `@unbrained/pm-cli@2026.10.4` into a disposable copy of this repository's real `.agents/pm`, and ran the following commands. Both runtimes exported 160 closed items. Markdown (12602 bytes) and JSON compare byte-identically. The scratch copy was deleted by the exit trap.

```text
+ npx -y @unbrained/pm-cli@2026.10.4 package install /tmp/claude-1000/cert-wt/pm-changelog-2026.10.4.tgz --project
action: "install"
+ npx -y @unbrained/pm-cli@2026.10.4 changelog generate --mode replace --output npm-changelog.md --release-version 2026.10.4
file: "/tmp/claude-1000/cert-wt/pm-changelog-dogfood/npm-changelog.md"
action: "created"
changed: true
item_count: 160
+ npx -y @unbrained/pm-cli@2026.10.4 changelog export --format json --output npm-changelog.json
file: "npm-changelog.json"
format: "json"
item_count: 160
+ bunx --bun -y @unbrained/pm-cli@2026.10.4 changelog generate --mode replace --output bun-changelog.md --release-version 2026.10.4
file: "/tmp/claude-1000/cert-wt/pm-changelog-dogfood/bun-changelog.md"
action: "created"
changed: true
item_count: 160
+ bunx --bun -y @unbrained/pm-cli@2026.10.4 changelog export --format json --output bun-changelog.json
file: "bun-changelog.json"
format: "json"
item_count: 160
+ cmp npm-changelog.md bun-changelog.md
+ cmp npm-changelog.json bun-changelog.json
{"exportType":"object","bytes":12602}
```

## Managed GitHub preview

Installed `npm:pm-github@2026.10.4` with `pm package install --project`. Read-only command `pm github sync --repo unbraind/pm-changelog --dry-run` reports:

```text
No pm items linked to unbraind/pm-changelog (no `gh:unbraind/pm-changelog#N` provenance tags).
synced: 0
skipped: 0
planned: 0
```

This is zero-case preview evidence. No GitHub issue writes or scheduled sync were performed. PR checks and substantive bot reviews must be assessed separately at the final head; the orchestrator owns merging and PM closure.

## Review follow-up

Managed extension payloads are clone-local installed distributions and are excluded from Git. Reproduce the read-only preview with `npx -y @unbrained/pm-cli@2026.10.4 package install npm:pm-github@2026.10.4 --project`, then `npx -y @unbrained/pm-cli@2026.10.4 github sync --repo unbraind/pm-changelog --dry-run`. The installed version and zero-case receipt above remain the evidence; no write-path acceptance is claimed.

The Node 22/npm 10 integration failure reproduced locally: npm runs `prepare` during `pack --ignore-scripts`, and the fixture tracker is outside the source Git checkout. Packaging now uses a separate environment without fixture `PM_PATH`/`PM_GLOBAL_PATH`; installation retains the original isolated environment and assertions.
Packaging also discovers the single actual tarball instead of parsing stdout, because npm 10 lifecycle output precedes its JSON metadata.

Review-corrected Node 22.23.1/npm 10.9.8 packed acceptance passes 2/2, zero skips; final locked full gate repeats 527/527 with unchanged 100% measured lines/branches/functions. Fixture cleanup still fails if removal cannot complete, with bounded retries increased for asynchronous fixture writes on the loaded host. Valid upstream apply-path findings are tracked in open [pmc-xndl](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-xndl.toon); excluding their generated distribution does not fix those upstream defects.
