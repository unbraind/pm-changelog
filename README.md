# pm-changelog

Generate `CHANGELOG.md` from pm-cli items.

[![pm total](https://pm-cli.unbrained.dev/badges/svg?repo=unbraind/pm-changelog&metric=items&style=flat&rt=1)](https://pm-cli.unbrained.dev/badges)
[![pm open](https://pm-cli.unbrained.dev/badges/svg?repo=unbraind/pm-changelog&metric=status&status=open&style=flat&rt=1)](https://pm-cli.unbrained.dev/badges)
[![pm in progress](https://pm-cli.unbrained.dev/badges/svg?repo=unbraind/pm-changelog&metric=status&status=in_progress&style=flat&rt=1)](https://pm-cli.unbrained.dev/badges)
[![pm closed](https://pm-cli.unbrained.dev/badges/svg?repo=unbraind/pm-changelog&metric=closed&style=flat&rt=1)](https://pm-cli.unbrained.dev/badges)
[![pm completion](https://pm-cli.unbrained.dev/badges/svg?repo=unbraind/pm-changelog&metric=completion&style=flat&rt=1)](https://pm-cli.unbrained.dev/badges)
[![pm last activity](https://pm-cli.unbrained.dev/badges/svg?repo=unbraind/pm-changelog&metric=last-activity&style=flat&rt=1)](https://pm-cli.unbrained.dev/badges)
[![pm history events](https://pm-cli.unbrained.dev/badges/svg?repo=unbraind/pm-changelog&metric=history-events&style=flat&rt=1)](https://pm-cli.unbrained.dev/badges)

## Install

```bash
pm install npm:pm-changelog --project
```

```bash
pm changelog generate --mode prepend --output CHANGELOG.md
```

Rebuild a full project changelog from git release tags:

```bash
pm changelog generate --all-release-tags --mode replace --output CHANGELOG.md
```

Tag-derived flags (`--all-release-tags`, `--since-previous-tag`,
`--until-release-tag`) require complete git tag history: in a shallow clone
they fail with an actionable `E_MISSING_TAG_HISTORY` diagnostic instead of
deriving an incomplete window. The diagnostic names the exact recovery for the
detected state — `git fetch --tags --unshallow` for a plain shallow clone, or
`git config --unset remote.origin.tagOpt && git fetch --tags --unshallow` when
the clone is also `--no-tags`; follow all commands it lists (see
[Release and CI](docs/release.md)).

Standalone npm usage:

```bash
npm install --save-dev pm-changelog @unbrained/pm-cli
npx pm-changelog --mode prepend --output CHANGELOG.md
```

The standalone CLI accepts both `--flag value` and `--flag=value` for value
options, and supports `--release-version` as a compatibility alias for
`--version` (matching `pm changelog generate` syntax).

Caller-supplied `--stdin` and `--input` JSON refuses envelopes whose explicit
pagination, source completeness, field omission, or compaction receipts report
unsafe delivery. Refusal exits nonzero before writing, preserving an existing
changelog. The public pm SDK (peer minimum `2026.10.4`) inspects these receipts. Ordinary status/date
filters select the caller's scope and do not imply incomplete retrieval.
Bare arrays and receipt-free `{ "items": [...] }` documents retain their
intentional subset contract: the caller owns their scope and must supply the
full intended history when replacing a changelog. See [JSON input](docs/usage.md).

Whole-tracker reads explicitly request the list-local `--full` projection because pm-cli 2026.10.18+ treats `--all` as row scope only and otherwise omits fields needed for changelog generation.

Date precedence is explicit: `--date` is an unconditional override, then an
existing release tag supplies its commit date, then `--date-fallback` or
`--date-from-version` applies only while that tag is absent. With none of those,
generation uses the current UTC calendar date. Release-gated CalVer packages can
therefore use `--date-from-version` (for example `2026.8.8` or `2026.8.8-2`
becomes `2026-08-08`) without masking the authoritative tag date after publication.
The optional numeric `-N` suffix distinguishes same-day releases and stays in
the version heading. Non-numeric suffixes and impossible calendar dates are rejected.
`--date-fallback` and `--date-from-version` are mutually exclusive. Explicit
and fallback date text is rendered verbatim; use `YYYY-MM-DD` for a conventional
changelog heading.

```bash
npx pm-changelog --release-version-from-package --date-from-version
npx pm-changelog --version 1.2.0 --date-fallback 2026-08-08
```

## Opt-in extras

These flags are strictly additive — omitting them keeps output byte-for-byte identical to the default:

```bash
npx pm-changelog --stdout --section-by type      # group by type/status/label instead of categories
npx pm-changelog --stdout --conventional         # Features / Bug Fixes / ... headings
npx pm-changelog --stdout --contributors         # per-release contributor list
npx pm-changelog --all-release-tags --limit 10   # keep only the newest N releases
npx pm-changelog --all-release-tags --since-version 2.0.0
npx pm-changelog --all-release-tags --changelog-json > changelog.json
npx pm-changelog --stdout --breaking-changes      # add a Breaking Changes section
npx pm-changelog --suggest-semver                 # print a suggested semver bump as JSON
npx pm-changelog --stdout --body-preview 80       # append first 80 chars of each item body
npx pm-changelog --stdout --emoji-prefix          # prefix headings with emoji (Added 🎉, Fixed 🐛, ...)
npx pm-changelog --stdout --include-metadata      # append type/status/priority/release/milestone per item
npx pm-changelog --stdout --json --explain        # emit selection diagnostics (counts + exclusion hints) for agents
npx pm-changelog --stdout --item-ref-style github  # link item IDs to public GitHub issues/PRs, not .agents/pm blobs
npx pm-changelog --stdout --item-ref-style label   # neutral (id) labels — safe for a published/public changelog
npx pm-changelog --stdout --respect-item-release    # honor each item's release field, not just closed_at
npx pm-changelog --stdout --exclude-tag changelog:ignore  # keep tagged items out of the changelog entirely
```

### Section rules

Closed Issue/Bug/Bugfix/Defect items use tracker evidence before type, tags or title:

| Recorded closure | Output |
| --- | --- |
| Not planned, duplicate, invalid, won't fix, superseded, cannot reproduce (any closed item type) | Omitted from changelog and release notes |
| Linked file path or test command/path; affirmative fix/repair/correction/resolution in `close_reason` or `resolution`; or delivered/merged PR or commit in `close_reason`, `resolution`, `actual_result` or `links` | Existing category rules, including Fixed for repairs |
| Other closed issues, including factual GitHub completion | `### Closed` with `Closed: <title>` |

A title, bug tag, completed timestamp, bare PR URL or GitHub issue link does not
prove a repair. Dispositions must lead `close_reason` or `resolution` (optionally
following “Closed as”, “Resolved as” or “Closed on GitHub as”); incidental words
like “Fixed duplicate grouping” remain repairs. Affirmative passive wording such
as “The parser crash was fixed” also records a repair. Negated, hypothetical or pending repair/delivery
statements do not qualify. Instructions such as “Fix after the next deploy” or
“Resolve in a follow-up release” need independent file/test or delivery evidence;
completed wording such as “Fixed the parser” qualifies on its own.
Structured delivery links use `url` with `state: merged`
or `relation: delivered`; string links must name delivery and a PR/commit reference.
Linked files/tests are recorded evidence, not independent verification that a test
passed or a repair shipped. Feature/Task category rules are retained.

The neutral prefix always uses the title, including with `--entry-from close_reason`
and alternate grouping, so factual closure prose never becomes a repair claim.
Neutral closures stay under Closed with `--section-by type`, `status` or `label`
too; a `fixed` label cannot bypass the evidence requirement.
They contribute no semver change counts and never appear in Breaking Changes,
even when their title, tags or metadata contain breaking signals.
JSON receipts/documents expose `excluded_non_change_count`, counted across input
before status/time/release filters. SDK generation/write results expose
`excludedNonChangeCount`. All projections omit the same non-change items.
Classification is deterministic and reads tracker data only. Existing tags and
release files are unchanged; regenerating history applies these rules to that output.
Prepending a new release preserves older sections unless explicitly regenerated.

### Without git

Generate from `--stdin`, `--input` or a tracker directory, export release notes,
classify closures and use explicit versions/dates without git. Git tag windows,
previous/release-tag selection and dependency commit notes need a git repository
with the required tag history.

### Resolution prose for release notes

Keep a defect description in the tracker title and put the fix in `close_reason`,
using `pm close <id> "Describe the fix"` or `pm update <id> --close-reason "Describe the fix"`.
Opt in with `--entry-from close_reason` on every generation, check, and release-notes
command (including the scripts in `package.json`). For example:

```bash
pm update <id> --close-reason "Fixed the comment-sync test to be independent of the root directory"
npx pm-changelog --entry-from close_reason --mode replace
npx pm-changelog --entry-from close_reason --mode replace --check
pm changelog generate --entry-from close_reason
pm changelog export --entry-from close_reason
```

Under Fixed, an Issue titled "The comment-sync test is root-sensitive" then renders
"Fixed the comment-sync test to be independent of the root directory". The title stays in the
tracker and still determines ordering; recorded evidence controls whether the issue can
be a repair. The selected field supplies prose in every category, markdown, summary,
structured JSON, and breaking change entry, except neutral Closed entries always use
the title across all output formats, including with `--entry-from close_reason`.
Markdown escaping and single-line normalization apply to the resolution too.
Only `title` (the default) and `close_reason` are supported; missing, empty, whitespace-only,
or non-string resolutions fall back to title. Omitting the flag uses the title; closure
evidence rules still apply.
The standalone `--json` receipt and structured document record an explicit source as
`entry_from`; SDK callers use `entryFrom: "close_reason"`.

`--check` also emits an advisory `defect_title` warning on stderr for visible closed Fixed
items with no usable `close_reason` and a recognized English present-tense failure or broken
state (such as "fails", "cannot", "is broken", or "is root-sensitive"). This conservative
heuristic is not a grammar validator. Leading resolution verbs such as "Fix" and "Correct"
are excluded. It follows the same status, tag, time, release, and
visibility filters as generation, and applies to conventional/emoji Fixed headings too.
Grouping by type, status, or label has no Fixed heading and produces no warning. The warning
leaves markdown, JSON stdout, and the drift exit code unchanged. Follow its `pm update <id>
--close-reason "Describe the fix"` recovery and use `--entry-from close_reason` consistently.

### Dependency updates: releases that ship only Dependabot bumps

A daily release fires whenever a commit landed since the last tag, and Dependabot merges are commits,
but sections are built from closed pm items. Without help, a dependency-only release gets an empty
notes file and no `CHANGELOG.md` section at all. `--dependency-updates` reads each release window's
commits from git (`git log --no-merges`) and adds a `### Dependencies` section, listed last, with one
bullet per Dependabot subject (`<type>(deps|deps-dev): bump …`). A window with no closed items but at
least one such commit still gets its version heading. Other commit subjects, including hand-written
`fix(deps): …` commits, are ignored: items remain the source of truth for everything else.

The range is exact: the commits between the previous release tag and this one (`--all-release-tags`
windows, or the tags `--since-previous-tag --until-release-tag` resolve), so a bump tagged into the
previous release never repeats. A release that is still pending reads up to `HEAD`. If the previous tag
is not an ancestor of this one (orphaned by a history rewrite), the window's time bounds select commits
within this release's own history instead. The bumps also appear in `--changelog-json` (as
`dependencies` on each release) and `--summary` (as `Dependencies` entries), and
`pm changelog export` accepts the flag too. It cannot be combined with `--group-by release` or
`milestone`, whose sections come from item metadata rather than git windows.

```bash
npx pm-changelog --stdout --since-previous-tag --until-release-tag --release-version-from-package \
  --item-url-base https://github.com/unbraind/pm-csv/blob/main/.agents/pm --dependency-updates
```

```markdown
## 2026.9.23 - 2026-09-23

### Dependencies

- Bump jscpd from 5.2.0 to 5.3.0 ([#129](https://github.com/unbraind/pm-csv/pull/129))
- Bump @types/node from 26.5.1 to 26.6.1 ([#132](https://github.com/unbraind/pm-csv/pull/132))
```

PR numbers link to `https://github.com/<owner>/<repo>/pull/<n>` only when `--item-url-base` is a
`https://github.com/<owner>/<repo>/…` URL; otherwise they print unlinked as `(#129)`. The flag is
opt-in because turning it on changes the generated `CHANGELOG.md` of any repository whose history
contains Dependabot merges, so each repository adopts it in one reviewed change.

`--item-ref-style` controls how pm item IDs render as references:

- `auto` (default) — an internal `.toon` blob link when `--item-url-base` is set, otherwise a neutral `(id)` label. Byte-for-byte identical to prior behavior.
- `label` — always a neutral `(id)` label, never a link. Use for changelogs published to a public registry, where `.agents/pm/...` blob URLs leak tracker structure and may 404.
- `toon` — force the internal `.toon` blob link (requires `--item-url-base`; falls back to a label when it is unset).
- `github` — render a public GitHub issue/PR link derived from the item's `gh:owner/repo#number` provenance tag (written by [pm-github](https://github.com/unbraind/pm-github)); items without a valid provenance tag fall back to a neutral label.

See [Usage](docs/usage.md#opt-in-enhancements) for details.

### Release attribution: work that shipped before its tracker was closed

By default an item lands in the release window that contains its **authoritative completion time** — `completed_at` (recorded by pm-cli ≥ 2026.7.29 separately from tracker close time). When `completed_at` is absent, generation falls back to `closed_at`, then `updated_at`, then `created_at`; those fallbacks are **inferred**, not authoritative. In multi-agent workflows an agent often ships the fix in one release and closes the tracker during a later one, which would date months-old work as new — and is why shipped-but-unclosed trackers pile up: closing them corrupts the changelog.

Record where the work actually landed and generation stops trusting `closed_at`:

```bash
pm update <id> --release 2026.6.1        # the release the fix actually shipped in
npx pm-changelog --stdout --release-version 2026.7.24 --respect-item-release
```

With `--respect-item-release`, an item that declares a `release` (top-level field or
`metadata.release`) is **pinned** to it: kept when it matches the generated version regardless of
timestamps, dropped otherwise (including from an unversioned `Unreleased` window — it already
shipped). Items without a declared release keep the plain time-window behavior, so output is
unchanged for workspaces that never set the field. `--all-release-tags` already honors the field and
is unaffected; the flag makes the single-window path (`--since-previous-tag --until-release-tag`,
`changelog:check`, release notes) agree with it. `--explain` reports what attribution dropped.

#### Inferred-attribution report

`--explain` also reports **attribution provenance**: how many visible items were placed in their
release window from the authoritative `completed_at` versus an inferred fallback (`closed_at`,
`updated_at`, or `created_at`), plus a bounded sample of the inferred item ids. This is how a
maintainer catches a shipped-but-late-closed item — one whose `completed_at` is missing so its
placement fell back to a `closed_at` recorded in a later release. Inspect the inferred sample, set
`completed_at` (or pin the item with `--release`), and regenerate.

### Excluding items

`--exclude-tag <tags>` (repeatable, comma-separated) omits items carrying any listed tag from every
generation path — an ignore convention for pm items that are legitimately tracked but are not
user-facing package changes (upstream issue mirrors, internal chores, superseded work):

```bash
pm update <id> --add-tags changelog:ignore
npx pm-changelog --stdout --exclude-tag changelog:ignore
```

Matching is case-insensitive and trims whitespace. The item stays in the tracker with its full
history — only the generated changelog skips it.

## Docs

- [Docs index](docs/README.md)
- [Usage](docs/usage.md)
- [Release and CI](docs/release.md)
- [Development](docs/development.md)
- [Changelog](CHANGELOG.md)

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly instead of hard-conflicting. The driver **definitions** live in
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script, `scripts/prepare-merge-driver.ts`: the launcher template pm-ops ships, copied unchanged, which a test compares byte for byte with the pinned template. It runs pm-ops's installer, which calls `pm merge install` when the `pm` CLI is on `PATH` and skips with a notice when it is not. A production install of a clone (`npm ci --omit=dev`) has no `pm-ops`, so the launcher skips with one notice, while a stale or broken `pm-ops` fails the install. Registry installs of this package never run `prepare`. Being Node-based, it behaves identically on POSIX shells and Windows `cmd.exe`. To (re)run manually: `npm run merge:install`.

After merging a branch that touched `.agents/pm/`, reconcile any residual history-hash drift with
**`pm merge reconcile`** (pm-cli ≥ 2026.7.22): preview with `pm merge reconcile --dry-run`, apply with
`pm merge reconcile --message "post-merge reconcile"`, then confirm with `pm validate`, which scans the
whole tracker and flags remaining history drift across **every** affected item (`pm merge reconcile`
itself lists each affected stream in its output; `pm history --verify <id>` spot-checks one item). The field-aware driver already unions every author's
content, so `reconcile` only re-greens the hash chain (no data loss) — see the authoritative
[pm-cli merge-safety guide](https://github.com/unbraind/pm-cli/blob/main/docs/MERGE_SAFETY.md). The
older blunt `pm history-repair --all` remains available as a lower-level primitive.

## Tracker release milestones

A named release can come from tracker state instead of Git tags. Freeze its
membership, then generate notes from those boundaries:

```sh
pm changelog milestone create 2026.10.21 --items 'tag:shipping'
pm changelog generate --milestones --stdout
pm changelog generate --milestones --summary --format json
# Standalone generator uses the same tracker source:
pm-changelog --milestones --stdout
```

Omitting `--items` freezes every item, including open work. Queries support `*`
or space-separated `id:`, `status:`, `type:`, `tag:`, and `release:` terms. Terms
are ANDed; comma-separated values within a term are alternatives. Values are
case-sensitive. This is a deliberately small selection grammar, not a shell
command. Use `status:closed` when only already-completed work belongs to a release.

An ID belongs to the first milestone that captures it closed, using that frozen
row. Earlier open captures reserve no release membership; live closures remain
Unreleased until captured closed. Later edits, reopening and deletion cannot grow
or rewrite an earlier release. Normal status and non-change filters still apply.
New captures must have strictly increasing RFC 3339 instants with explicit offsets;
backward/equal clocks and ambiguous ordering refuse. Repeating a
name with the same IDs returns the original snapshot; changed membership refuses
with `milestone_membership_changed` and a remedy to create a new name. Snapshot
fingerprints are checked before generation. New names are lowercase portable
tokens of at most 80 characters, excluding reserved device names. Snapshots live
under the tracker's `changelog/milestones/` directory.
Keep these records with tracker backups and synchronize them with tracker data.
The creation receipt contains only name, fingerprint, timestamp and item count;
body/description, comments and unrelated metadata are never stored. Retained
rendering and classification fields are fingerprinted; full rows are not printed.
The host renders receipts as TOON or JSON.

`--milestones` selects the release source. Git-window, explicit version/date and
metadata-grouping options, `--body-preview`, `--pm-bin` and `--pm-arg` cannot be
combined with it. Existing `--group-by
milestone` remains mutable item-field grouping. A tracker inside a Git repository
can still use `--all-release-tags` in a separate invocation. Outside a Git
repository, explicit tag options (`--all-release-tags`, `--since-previous-tag`,
and `--until-release-tag`) now fail with `MissingTagHistoryError` instead of
silently falling back to a single section.

The typed SDK accepts complete backend snapshots through `createReleaseMilestone`
and an atomic `ReleaseMilestoneStore`. Use `resolveTrackerReleaseHistory` with
`createChangelog`, `buildChangelogDocument` or `createChangelogSummary`. Database
adapters must use transactional insert-if-absent and consistent complete snapshot
reads; no SQL server or hosted access is required by this package. See the
[SDK example](docs/tracker-milestones.md).


## Audit release claims before publication

`pm changelog audit` maps every generated release-note line to its source item,
resolution, linked files/tests and recorded delivery. It preserves the generator's
selection and wording, including neutral `Closed` entries for factual closures.
Missing evidence stays in `gaps`; a closed issue alone cannot justify `Fixed`.
Repair gaps follow the classified item category across conventional headings,
custom grouping and repeated Breaking Changes entries.

```bash
pm changelog audit --entry-from close_reason
pm changelog audit --entry-from close_reason --format json
pm changelog audit --audit-receipts receipts.json --format json --check
# Standalone: all generation filters and release-window flags still apply.
pm-changelog audit --pm-root .agents/pm --entry-from close_reason --json
```

The default compact TOON report has one row per claim, one evidence record per
item, and a shared remedy dictionary. JSON carries native arrays/objects; TOON
encodes nested collections as JSON strings. Line numbers are one-based in the
freshly generated Markdown, identified by `markdown_sha256`. Repeated items in
label groups or Breaking Changes retain separate line mappings. Contributors map
to the selected items' credit metadata; `No changes.` maps to the empty selection.
Existing prepended history is outside this generated-document audit.

`--check` exits nonzero on any gap; normal audit mode exits zero and returns the
complete report. The standalone command prints that report to stdout before
refusing. Host commands (`pm changelog audit` and `pm changelog generate
--audit-evidence`) print the selected JSON or TOON report to stderr before a failed
check throws, preserving line mappings, gaps and remedies. Successful host checks
return one report through normal output.
`ClaimAuditError` exposes `code`, `remedy` and, for unsupported claims, `report`.
Git-dependent dependency audits refuse as `git_required` without a repository; drop
`--dependency-updates` to continue a tracker-only audit. Duplicate or missing item IDs refuse as `ambiguous_items`; malformed execution
receipts refuse as `invalid_receipts`. Fix the named input and regenerate.

A linked test command is a declaration, not a passing run. Supply a JSON array
of `{ "item", "command", "outcome", "reference" }` execution receipts through
`--audit-receipts`. Outcomes are `passed` or `failed`; commands must match a linked
command or test path. Every linked command/path needs a passing receipt. A failed matching receipt prevents that command from being
accepted as passing. References remain in the report for inspection. Recorded
merge/delivery language must name a PR or commit; a bare issue URL does not count.
Dependency commit subjects retain an explicit evidence gap.

This is an audit of recorded support, with no test execution, file existence
check, remote receipt authentication or semantic proof of arbitrary prose. Caller
receipts are assertions: maintainers must verify their relevance to the release.
`pm-review` owns review validation; `pm-ops` owns publication provenance.
See the [SDK and receipt example](docs/claim-audit-example.md).

## Without git

Tracker milestone creation/generation, ordinary generation, export, audience contracts, consumer upgrades and claim audits
work in plain directories and through caller-supplied SDK items without Git.
Milestone paths invoke no Git subprocess. Git tag windows, historical
Git membership and dependency commit collection require a Git repository. Use
tracker fields or explicit dates for a tracker-only audit.

## Ordered consumer upgrade obligations

Author `breaking: true` and `upgrade_actions` on a `change_facets` declaration,
then compile the obligations between an installed version and a target version:

```sh
pm changelog upgrades --audience operator --from 1.0.0 --to 4.0.0 --format json
pm-changelog upgrades --pm-root .agents/pm --audience operator --from 1.0.0 --to 4.0.0
```

Only explicitly authored actions become pending core Plan step data. The SDK
orders their prerequisites, deduplicates identical action IDs across releases,
and refuses missing prerequisites, conflicting definitions and cycles with
typed remedies. Commands, titles and release prose are never executed or inferred
as actions. Both commands read complete native metadata through the SDK without
git. Output defaults to compact TOON; `--json` selects compact JSON.

Use `buildConsumerUpgrades`, `readConsumerUpgrades` and `formatConsumerUpgrades`
from the typed SDK. See the [three-release example and range contract](docs/consumer-upgrades.md)
and [measured public-tracker validation](docs/consumer-upgrade-validation.md).

## Audience-specific change contracts

Publish only explicitly tagged facets of closed change items for API users,
operators and agents, preserving one canonical attribution ledger:

```sh
pm changelog contracts --group-by release --audience operator --format json
pm-changelog contracts --pm-root .agents/pm --format toon
```

Core metadata stores `change_facets` as `{audience, text}` or
`{audience, source: "close_reason"}` declarations. Audiences are `api-user`,
`operator` and `agent-behavior`; omit the audience to generate all three.
Missing facets and missing requested resolutions produce explicit omissions.
The generator reuses release selection, section rules and resolution rendering.
`buildAudienceContracts`, `readAudienceContracts` and `formatAudienceContracts`
provide the typed SDK, compact JSON/TOON and typed refusals with remedies.
These commands work without git. See the [worked example and contract](docs/audience-contracts.md).
