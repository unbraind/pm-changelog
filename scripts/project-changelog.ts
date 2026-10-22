import { cliTestSurface } from "../src/cli.ts";

/** Project release notice retained by every full changelog regeneration. */
const PROJECT_CHANGELOG_TITLE = "Changelog\n\n> Compatibility: explicit tag options (--all-release-tags, --since-previous-tag, --until-release-tag) now require an accessible Git repository and fail with MissingTagHistoryError in source archives and container contexts without Git history. Use tracker-only generation or --milestones there.";

await cliTestSurface.main([
  "--pm-root",
  ".agents/pm",
  "--mode",
  "replace",
  "--output",
  "CHANGELOG.md",
  "--all-release-tags",
  "--release-version-from-package",
  "--date-from-version",
  "--item-url-base",
  "https://github.com/unbraind/pm-changelog/blob/main/.agents/pm",
  "--respect-item-release",
  "--pm-bin",
  "./node_modules/.bin/pm",
  "--pm-arg=--output-budget",
  "--pm-arg=unbounded",
  "--pm-arg=--output-limit",
  "--pm-arg=unbounded",
  "--title", PROJECT_CHANGELOG_TITLE,
  ...process.argv.slice(2),
]);
