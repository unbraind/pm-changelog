# Changelog

## Unreleased - 2026-05-23

### Added

- Regenerate release changelog from pm items (pmc-a6qg)
- Harden npm package metadata and CI release gates (pmc-otpe)

### Security

- Audit git history for private data exposure (pmc-91po)

### Other

- Release pm-changelog 0.1.0 as a production-ready pm package (pmc-ysps)
- Document pm governance for the package lifecycle (pmc-xl68)
- Align GitHub repository settings for public package release (pmc-w1sp)
- Verify pm-changelog in a clean temporary project (pmc-800h)

## 0.1.0 - 2026-05-17

### Added

- Initial `pm-changelog` CLI for generating `CHANGELOG.md` from pm item JSON or `pm list-all --json`.
- Programmatic APIs for creating, merging, reading, and writing changelogs from Node.js scripts and CI runners.
- Package metadata for `pm install github.com/unbraind/pm-changelog --project`, `pm install npm:pm-changelog --project`, and catalog discovery.
- `--release-version` for the pm extension command so release headings do not collide with the global `pm --version` flag.
- Custom pm executable support via `--pm-bin` and `readPmItems({ pmBin })`.
- Programmatic runner wrapper support with `readPmItems({ pmArgs, cwd, env })`.
- pm-cli extension command: `pm changelog generate`.
- GitHub Actions support with JSON summaries, check mode, prepend mode, and `$GITHUB_OUTPUT` fields.
- Optional `$GITHUB_STEP_SUMMARY` publishing via `--github-step-summary`.
- GitHub Actions CI workflow for validating package builds and tests.
- Release and milestone grouping for projects that store release metadata on pm items.
- Tracked built runtime output so GitHub and local pm package installs work without a separate build step.

### Security

- Item URLs are omitted by default.
- Opt-in item links strip credentials, query strings, and fragments before markdown output.
