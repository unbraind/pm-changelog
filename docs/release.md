# Release and CI

## Local Release Gate

Run the full local release gate before tagging or publishing:

```bash
npm run release:check
```

The gate:

- Type-checks the TypeScript source.
- Builds and runs the TypeScript-authored test suite.
- Audits production dependencies.
- Verifies package contents with `npm pack --dry-run`.
- Checks that `CHANGELOG.md` is current.

The changelog check derives its release window from git tags, so release
validation requires a checkout with tag history. Both repository workflows use
`actions/checkout` with `fetch-depth: 0`. Before running the gate in a shallow
or tagless clone, restore the tag refs:

```bash
git fetch --tags --force
```

A sandbox that intentionally omits tags cannot reconstruct the previous-tag to
release-tag window and is not a valid changelog release-gate environment.

## Automated Release

`.github/workflows/release.yml` runs daily and by manual dispatch. It uses free GitHub Actions features only.

The workflow skips publishing when there are no commits after the latest release tag. When changes exist, it:

- Computes the next date-based tag in the configured release timezone, currently `Europe/Vienna`.
- Updates `package.json`, `package-lock.json`, `manifest.json`, and `src/extension.ts`.
- Rebuilds `dist/`.
- Generates or refreshes the current `CHANGELOG.md` release section with `pm-changelog` itself while preserving older release sections.
- Runs release checks.
- Commits release files.
- Pushes the release commit to a deterministic `release/<version>` branch and creates or reuses a pull request.
- Merges that pull request through normal `main` branch protection, then checks out and fully revalidates the exact merged commit.
- Publishes to npm with provenance.
- Tags the verified merged commit and removes the temporary release branch.
- Creates the public GitHub release.

The workflow never pushes a release commit directly to `main`, and it never
publishes npm before the matching version metadata and changelog are present on
protected `main`. If publication fails after the release PR merges, the next run
recognizes that the release metadata is already on `main` and retries the same
version, including after the local calendar date changes. It also skips an npm
version that the registry already contains, which lets an interrupted run
converge without duplicating publication. If npm and the tag exist but GitHub
release creation was interrupted, a no-change run verifies the registry package
and reconstructs the missing GitHub release from the tagged changelog window.
Provenance is mandatory: after three failed attested publish attempts, the run
fails and relies on the same-version recovery path instead of silently
downgrading the package's supply-chain evidence.

Required repository secret:

```text
NPM_TOKEN
```

Required `release` job permissions (scoped to that job, not the workflow):

- `contents: write` for release commits, tags, and GitHub releases.
- `id-token: write` for npm provenance.
- `pull-requests: write` for the protected release-metadata PR transaction.

The repository must also enable **Settings → Actions → General → Workflow
permissions → Allow GitHub Actions to create and approve pull requests**. Keep
the repository's default `GITHUB_TOKEN` permission read-only; the release
workflow's `release` job declares only the three write capabilities above. GitHub documents
this repository setting in [Managing GitHub Actions settings for a
repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#preventing-github-actions-from-creating-or-approving-pull-requests).

The release merge uses GitHub's pull-request merge endpoint with the prepared
release commit as the required head `sha`. A changed head is rejected instead
of being merged accidentally; see [Merge a pull
request](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request).

## Versioning

Release tags follow the pm CLI date-based convention:

```text
vYYYY.MM.DD
vYYYY.MM.DD-N
```

npm package versions use the SemVer-compatible equivalent without the leading `v` or zero-padded numeric components:

```text
2026.5.23
2026.5.23-1
```

The automated workflow uses `RELEASE_TIMEZONE=Europe/Vienna` when computing date-based tags. This avoids UTC rollover surprises for manual dispatches near local midnight.

## GitHub Checks

Use `gh` for release readiness checks:

```bash
gh repo view --json nameWithOwner,visibility,defaultBranchRef,hasIssuesEnabled,hasProjectsEnabled,hasWikiEnabled,latestRelease
gh issue list --limit 50
gh pr list --limit 50
gh run list --limit 20
gh secret list
gh api repos/unbraind/pm-changelog/dependabot/alerts
```

## npm Checks

Use npm registry and dependency checks:

```bash
npm outdated --json
npm audit --omit=dev
npm view pm-changelog version dist-tags time --json
```

## Public Release Verification

After publishing, verify:

```bash
npm view pm-changelog version dist-tags --json
gh release view "$(git describe --tags --abbrev=0)"
```

Then install from a clean temporary pm project:

```bash
tmp="$(mktemp -d)"
cd "$tmp"
pm init --json
pm install npm:pm-changelog --project --json
pm package doctor --project --json --detail deep
```
