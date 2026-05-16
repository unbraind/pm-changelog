# Changelog

## 0.1.0 - 2026-05-17

### Added

- Initial `pm-changelog` CLI for generating `CHANGELOG.md` from pm item JSON or `pm list-all --json`.
- Programmatic APIs for creating, merging, reading, and writing changelogs from Node.js scripts and CI runners.
- pm-cli extension command: `pm changelog generate`.
- GitHub Actions support with JSON summaries, check mode, prepend mode, and `$GITHUB_OUTPUT` fields.
- Optional `$GITHUB_STEP_SUMMARY` publishing via `--github-step-summary`.
- GitHub Actions CI workflow for validating package builds and tests.
- Release and milestone grouping for projects that store release metadata on pm items.

### Security

- Item URLs are omitted by default.
- Opt-in item links strip credentials, query strings, and fragments before markdown output.
