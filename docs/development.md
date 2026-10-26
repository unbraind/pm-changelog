# Development

## Layout

```text
pm-changelog/
  manifest.json          pm extension manifest
  package.json           npm metadata plus pm package catalog metadata
  src/                   TypeScript source
  test/                  TypeScript test source
  dist/                  built CLI, API, and extension runtime
  docs/                  detailed documentation
```

`dist/` is tracked intentionally so GitHub and local pm package installs work without a build step. npm packaging still runs `npm run build` through `prepack`.

## TypeScript Policy

Source and tests are TypeScript. Do not add JavaScript source files.

The pm extension must use the official SDK surface:

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";
```

Do not import private pm-cli internals or add local SDK shims. If an official SDK feature is missing or broken, open an issue in `unbraind/pm-cli` and document the package-side impact in pm project management.

## Commands

Install dependencies:

```bash
npm ci
```

Build:

```bash
npm run build
```

Type-check:

```bash
npm run check
```

Run tests:

```bash
npm test
```

`test/help-parser-contract.test.ts` checks root, audit, contracts and upgrades
help against flag spellings discovered from their parser syntax, including
short flags and aliases. It also checks each root subcommand synopsis with its
continuation lines and exercises the flags through the real parsers. When
adding a command or changing parser structure, update this contract test;
keep parser inventory independent of the help text and suggestion lists.

Regenerate changelog:

```bash
npm run changelog:full
```

This is the only generator, and `changelog:check` verifies exactly what it
writes. Rendering in prepend mode instead produces a file the gate rejects,
because replace mode also emits an `## Unreleased` section for closed but
unreleased work and orders released items by their `release:` field.

Both `changelog:full` and `release:notes` pass `--date-from-version`; keep that
flag when editing either script or the release workflow. An untagged calendar
version such as `2026.8.8-2` renders `2026.8.8-2 - 2026-08-08`, independently
of the day generation runs. `test/release-backlog.test.ts` exercises these
script arguments through the built CLI against a disposable real tracker.

Package-version lookup fixtures use `resolveReleaseContext`'s optional
`packageSearchBoundary` to own the whole lookup tree. It is an inclusive
ancestor of `cwd`; metadata above it is ignored and an unrelated boundary
throws. The default still searches through filesystem root. Plant a decoy
package above the fixture boundary to prove the missing-package case without
depending on ambient temporary-directory metadata.

See [backlog verification](backlog-verification.md) for the shipped fixes and
the remaining statement-coverage, upstream sync, and worker-startup designs.

Verify changelog:

```bash
npm run changelog:check
```

Run the full release gate:

```bash
npm run release:check
```

## pm Project Management

Use pm items for release governance, features, tasks, chores, issues, and verification evidence.

Recommended checks:

```bash
pm health --json
pm validate --json --check-metadata --check-resolution --check-lifecycle --check-command-references --check-history-drift --strict-exit
pm --output-budget unbounded --output-limit unbounded list --all --json
```

Every release-readiness item should record:

- Acceptance criteria.
- Files and docs touched.
- Tests and commands run.
- GitHub/npm/security evidence.
- Final resolution and actual result.

Close items before final changelog generation so `CHANGELOG.md` includes the completed work.

## Temporary Install Test

The node-entrypoint acceptance fixture owns separate project and global PM roots
and explicitly sets `PM_TELEMETRY_DISABLED=1` for its child commands. PM CLI
telemetry flushes run in detached processes, so `execFileSync` completion does
not mean those writers have finished. A syscall trace for issue #226 showed a
flush worker recreating the deleted fixture root and writing telemetry state
after teardown. Cleanup retries alone cannot prevent that recreation.

The regression enables telemetry in fixture settings and opts into test events,
then verifies the CLI launches no detached telemetry worker and creates neither
telemetry runtime artifacts nor an installation identity. A Node preload probe
records actual worker launches and delays their startup. Removing the opt-out
therefore exposes a worker that outlives the foreground command; the regression
cleanup terminates and waits for every observed worker before removing its
roots. Its negative control uses a loopback endpoint. Persistent process or
directory cleanup errors still fail the test.

Run these checks directly after building:

```bash
node --test --test-name-pattern='node-entrypoint fixture suppresses delayed telemetry|^pm extension command works when only node cli entrypoint is available$' test/generator.test.ts
```

Use a clean folder to prove pm package installation:

```bash
npm run build
package_root="$PWD"
tmp="$(mktemp -d)"
cd "$tmp"
pm init --json
pm install "$package_root" --project --json
pm package doctor --project --json --detail deep
pm create --type task --title "Verify pm-changelog install" --description "Smoke test" --status closed --json
pm changelog generate --output CHANGELOG.md --release-version smoke --date 2026-05-24 --json
```

For published package verification, replace the local path with:

```bash
pm install npm:pm-changelog --project --json
```

## Secret Review

Before public release, scan reachable history and filenames for private data. Synthetic test fixtures such as sanitized `token=secret` URLs are acceptable only when documented as false positives.
