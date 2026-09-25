/**
 * Tests for the opt-in `--dependency-updates` feature, which reads
 * Dependabot-shaped git commits from each release window and renders them in a
 * `### Dependencies` section. Every test uses a real temporary git repository
 * with real commits and tags — no mocked git, no stubbed child_process.
 */
import { describe, it } from "node:test";
import { equal, ok } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildChangelogDocument, createChangelog, createChangelogSummary, parseDependencyCommit, resolveGithubOwnerRepo } from "../src/index.ts";
import type { PmItem } from "../src/index.ts";

// ---------------------------------------------------------------------------
// Helpers: real temporary git repositories
// ---------------------------------------------------------------------------

/** Create a throwaway git repo with a single initial commit. */
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-deps-"));
  gitIn(dir, ["init", "--quiet", "--initial-branch=main"]);
  gitIn(dir, ["config", "user.email", "test@example.com"]);
  gitIn(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "file.txt"), "initial\n", "utf-8");
  gitIn(dir, ["add", "."]);
  gitIn(dir, ["commit", "--quiet", "-m", "Initial commit"]);
  return dir;
}

/** Run git in a fixture repo, returning trimmed stdout. */
function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** Commit the working tree with a given message and optional fixed date. */
function commitIn(dir: string, message: string, date?: string): void {
  writeFileSync(join(dir, "file.txt"), `${Date.now()}\n`, "utf-8");
  gitIn(dir, ["add", "."]);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (date) {
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  execFileSync("git", ["commit", "--quiet", "-m", message], {
    cwd: dir,
    encoding: "utf-8",
    stdio: ["ignore", "ignore", "ignore"],
    env,
  });
}

/** A closed item fixture used across tests. */
function closedItem(id: string, title: string, updatedAt: string): PmItem {
  return { id, title, status: "closed", type: "Feature", updated_at: updatedAt };
}

// ---------------------------------------------------------------------------
// parseDependencyCommit unit tests
// ---------------------------------------------------------------------------

describe("parseDependencyCommit", () => {
  it("parses a build(deps-dev) subject with a PR number", () => {
    const result = parseDependencyCommit("build(deps-dev): bump jscpd from 5.2.0 to 5.3.0 (#129)");
    ok(result);
    equal(result.description, "Bump jscpd from 5.2.0 to 5.3.0");
    equal(result.prNumber, 129);
  });

  it("parses a chore(deps) group bump subject", () => {
    const result = parseDependencyCommit("chore(deps): bump the codeql-action group with 2 updates (#105)");
    ok(result);
    equal(result.description, "Bump the codeql-action group with 2 updates");
    equal(result.prNumber, 105);
  });

  it("parses a subject with an across-N-directory group", () => {
    const result = parseDependencyCommit(
      "chore(deps): bump the npm_and_yarn group across 1 directory with 3 updates (#88)",
    );
    ok(result);
    equal(result.description, "Bump the npm_and_yarn group across 1 directory with 3 updates");
    equal(result.prNumber, 88);
  });

  it("parses a subject without a PR number", () => {
    const result = parseDependencyCommit("build(deps): bump taiki-e/install-action from 2.87.16 to 2.87.18");
    ok(result);
    equal(result.description, "Bump taiki-e/install-action from 2.87.16 to 2.87.18");
    equal(result.prNumber, undefined);
  });

  it("returns undefined for a non-Dependabot subject", () => {
    equal(parseDependencyCommit("feat: add new flag"), undefined);
    equal(parseDependencyCommit("fix(parser): handle edge case (#42)"), undefined);
    equal(parseDependencyCommit("Merge pull request #129"), undefined);
  });

  it("returns undefined when a deps-scoped subject lacks the ': bump ' separator", () => {
    // Dependabot always writes "<type>(deps): bump "; without the separator the
    // subject is not Dependabot-shaped and there is no description to extract.
    equal(parseDependencyCommit("build(deps):bump"), undefined);
  });
});

// ---------------------------------------------------------------------------
// resolveGithubOwnerRepo unit tests
// ---------------------------------------------------------------------------

describe("resolveGithubOwnerRepo", () => {
  it("extracts owner/repo from a GitHub blob URL", () => {
    const result = resolveGithubOwnerRepo(
      "https://github.com/unbraind/pm-changelog/blob/main/.agents/pm",
    );
    ok(result);
    equal(result.owner, "unbraind");
    equal(result.repo, "pm-changelog");
  });

  it("returns undefined for a non-GitHub URL", () => {
    equal(resolveGithubOwnerRepo("https://example.test/items"), undefined);
    equal(resolveGithubOwnerRepo("https://gitlab.com/owner/repo"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Single-window mode: --stdout --since-previous-tag --until-release-tag
// ---------------------------------------------------------------------------

describe("dependency-updates: single window", () => {
  it("collects Dependabot commits into a ### Dependencies section", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "build(deps-dev): bump jscpd from 5.2.0 to 5.3.0 (#129)", "2026-09-20T10:00:00Z");
      commitIn(dir, "chore(deps): bump the codeql-action group with 2 updates (#105)", "2026-09-21T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.23"]);
      commitIn(dir, "build(deps): bump @types/node from 26.5.1 to 26.6.2 (#104)", "2026-09-22T10:00:00Z");

      const result = createChangelog({
        items: [],
        version: "2026.09.23",
        date: "2026-09-23",
        since: "2026-09-20T00:00:00Z",
        until: "2026-09-23T23:59:59Z",
        dependencyUpdates: true,
        gitCwd: dir,
      });

      ok(result.markdown.includes("### Dependencies"), "output must contain a Dependencies heading");
      ok(result.markdown.includes("Bump jscpd from 5.2.0 to 5.3.0"), "must list the jscpd bump");
      ok(result.markdown.includes("Bump the codeql-action group with 2 updates"), "must list the group bump");
      ok(!result.markdown.includes("No changes."), "must not say No changes when there are dependency commits");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("links PRs to GitHub when --item-url-base is a GitHub URL", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "build(deps-dev): bump jscpd from 5.2.0 to 5.3.0 (#129)", "2026-09-20T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.23"]);

      const result = createChangelog({
        items: [],
        version: "2026.09.23",
        date: "2026-09-23",
        since: "2026-09-20T00:00:00Z",
        until: "2026-09-23T23:59:59Z",
        dependencyUpdates: true,
        gitCwd: dir,
        itemUrlBase: "https://github.com/unbraind/pm-csv/blob/main/.agents/pm",
      });

      ok(
        result.markdown.includes("[#129](https://github.com/unbraind/pm-csv/pull/129)"),
        "PR must be a GitHub pull link",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders unlinked (#NNN) when --item-url-base is not a GitHub URL", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "build(deps-dev): bump jscpd from 5.2.0 to 5.3.0 (#129)", "2026-09-20T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.23"]);

      const result = createChangelog({
        items: [],
        version: "2026.09.23",
        date: "2026-09-23",
        since: "2026-09-20T00:00:00Z",
        until: "2026-09-23T23:59:59Z",
        dependencyUpdates: true,
        gitCwd: dir,
        itemUrlBase: "https://example.test/items",
      });

      ok(result.markdown.includes("(#129)"), "PR must be an unlinked reference");
      ok(!result.markdown.includes("](https://"), "must not contain any markdown links");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends ### Dependencies after item-based sections", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "build(deps-dev): bump jscpd from 5.2.0 to 5.3.0 (#129)", "2026-09-20T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.23"]);

      const items = [closedItem("pmc-1", "Add feature flag", "2026-09-21T00:00:00Z")];
      const result = createChangelog({
        items,
        version: "2026.09.23",
        date: "2026-09-23",
        since: "2026-09-20T00:00:00Z",
        until: "2026-09-23T23:59:59Z",
        dependencyUpdates: true,
        gitCwd: dir,
      });

      const addedIdx = result.markdown.indexOf("### Added");
      const depsIdx = result.markdown.indexOf("### Dependencies");
      ok(addedIdx !== -1, "must have an Added section");
      ok(depsIdx !== -1, "must have a Dependencies section");
      ok(addedIdx < depsIdx, "Dependencies must come after item-based sections");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes merge commits from the dependency window", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "build(deps): bump jscpd from 5.2.0 to 5.3.0 (#129)", "2026-09-20T10:00:00Z");
      // Create a branch and merge it back so there is a merge commit
      gitIn(dir, ["branch", "feature"]);
      gitIn(dir, ["checkout", "--quiet", "feature"]);
      commitIn(dir, "feat: add feature", "2026-09-21T10:00:00Z");
      gitIn(dir, ["checkout", "--quiet", "main"]);
      gitIn(dir, ["merge", "--no-ff", "--quiet", "-m", "Merge branch 'feature'", "feature"]);
      gitIn(dir, ["tag", "v2026.09.23"]);

      const result = createChangelog({
        items: [],
        version: "2026.09.23",
        date: "2026-09-23",
        since: "2026-09-20T00:00:00Z",
        until: "2026-09-23T23:59:59Z",
        dependencyUpdates: true,
        gitCwd: dir,
      });

      ok(result.markdown.includes("Bump jscpd"), "must include the dependency bump");
      ok(!result.markdown.includes("Merge branch"), "must not include the merge commit");
      ok(!result.markdown.includes("add feature"), "must not include the non-dependency commit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// All-release-tags mode: item-less dependency-only window
// ---------------------------------------------------------------------------

describe("dependency-updates: all-release-tags", () => {
  it("produces a version section for an item-less dependency-only window", () => {
    const dir = gitRepo();
    try {
      // First release: has a pm item
      commitIn(dir, "feat: add initial feature", "2026-09-15T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.18"]);

      // Second release: only Dependabot commits, no pm items
      commitIn(dir, "build(deps-dev): bump jscpd from 5.2.0 to 5.3.0 (#129)", "2026-09-19T10:00:00Z");
      commitIn(dir, "chore(deps): bump the codeql-action group with 2 updates (#105)", "2026-09-20T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.23"]);

      const items = [
        { ...closedItem("pmc-1", "Add initial feature", "2026-09-15T00:00:00Z"), release: "2026.09.18" },
      ];
      const result = createChangelog({
        items,
        releaseWindows: [
          { heading: "2026.9.23 - 2026-09-23", releaseTag: "v2026.09.23", since: "2026-09-18T00:00:00Z", sinceExclusive: true, until: "2026-09-23T00:00:00Z" },
          { heading: "2026.9.18 - 2026-09-18", releaseTag: "v2026.09.18", until: "2026-09-18T00:00:00Z" },
        ],
        dependencyUpdates: true,
        gitCwd: dir,
      });

      // The dependency-only window (v2026.09.23) must appear with a Dependencies section
      ok(result.markdown.includes("2026.9.23"), "must include the dependency-only version heading");
      ok(result.markdown.includes("### Dependencies"), "must include a Dependencies section");
      ok(result.markdown.includes("Bump jscpd from 5.2.0 to 5.3.0"), "must list the jscpd bump");
      ok(result.markdown.includes("Bump the codeql-action group with 2 updates"), "must list the group bump");
      // The item-based window (v2026.09.18) must also appear
      ok(result.markdown.includes("2026.9.18"), "must include the item-based version heading");
      ok(result.markdown.includes("Add initial feature"), "must include the item from the first release");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collects dependency commits from the oldest window (no sinceRef)", () => {
    const dir = gitRepo();
    try {
      // Oldest release: has a Dependabot commit (no older tag → no sinceRef)
      commitIn(dir, "build(deps): bump actions/checkout from 3 to 4 (#51)", "2026-09-10T10:00:00Z");
      commitIn(dir, "feat: add first feature", "2026-09-11T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.12"]);

      // Newer release: has a pm item
      commitIn(dir, "feat: add second feature", "2026-09-15T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.18"]);

      const items = [
        { ...closedItem("pmc-2", "Add second feature", "2026-09-15T00:00:00Z"), release: "2026.09.18" },
        { ...closedItem("pmc-1", "Add first feature", "2026-09-11T00:00:00Z"), release: "2026.09.12" },
      ];
      const result = createChangelog({
        items,
        releaseWindows: [
          { heading: "2026.9.18 - 2026-09-18", releaseTag: "v2026.09.18", since: "2026-09-12T00:00:00Z", sinceExclusive: true, until: "2026-09-18T00:00:00Z" },
          { heading: "2026.9.12 - 2026-09-12", releaseTag: "v2026.09.12", until: "2026-09-12T00:00:00Z" },
        ],
        dependencyUpdates: true,
        gitCwd: dir,
      });

      // The oldest window (v2026.09.12) must include the dependency commit
      ok(result.markdown.includes("2026.9.12"), "must include the oldest version heading");
      ok(result.markdown.includes("Bump actions/checkout from 3 to 4"), "must list the oldest dependency bump");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not emit a section for a window with neither items nor dependency commits", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "feat: add feature", "2026-09-15T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.18"]);

      // Second window: no commits at all (no new commits between tags)
      gitIn(dir, ["tag", "v2026.09.20"]);

      const items = [
        { ...closedItem("pmc-1", "Add feature", "2026-09-15T00:00:00Z"), release: "2026.09.18" },
      ];
      const result = createChangelog({
        items,
        releaseWindows: [
          { heading: "2026.9.20 - 2026-09-20", releaseTag: "v2026.09.20", since: "2026-09-18T00:00:00Z", sinceExclusive: true, until: "2026-09-20T00:00:00Z" },
          { heading: "2026.9.18 - 2026-09-18", releaseTag: "v2026.09.18", until: "2026-09-18T00:00:00Z" },
        ],
        dependencyUpdates: true,
        gitCwd: dir,
      });

      // The empty window (v2026.09.20) must NOT appear
      ok(!result.markdown.includes("2026.9.20"), "must not include a window with no items and no dependency commits");
      ok(result.markdown.includes("2026.9.18"), "must include the item-based window");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collects dependency commits from the Unreleased window", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "feat: add feature", "2026-09-15T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.18"]);
      // Commits after the latest tag go into the Unreleased window
      commitIn(dir, "build(deps): bump jscpd from 5.2.0 to 5.3.0 (#129)", "2026-09-20T10:00:00Z");

      const items = [
        { ...closedItem("pmc-1", "Add feature", "2026-09-15T00:00:00Z"), release: "2026.09.18" },
      ];
      const result = createChangelog({
        items,
        releaseWindows: [
          { heading: "Unreleased", since: "2026-09-18T00:00:00Z", sinceExclusive: true },
          { heading: "2026.9.18 - 2026-09-18", releaseTag: "v2026.09.18", until: "2026-09-18T00:00:00Z" },
        ],
        dependencyUpdates: true,
        gitCwd: dir,
      });

      ok(result.markdown.includes("Unreleased"), "must include the Unreleased heading");
      ok(result.markdown.includes("### Dependencies"), "must include a Dependencies section in Unreleased");
      ok(result.markdown.includes("Bump jscpd"), "must list the dependency bump in Unreleased");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Byte-identical output without the flag
// ---------------------------------------------------------------------------

describe("dependency-updates: flag absent is byte-identical", () => {
  it("produces identical output with and without --dependency-updates when no dependency commits exist", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "feat: add feature", "2026-09-15T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.18"]);

      const items = [
        { ...closedItem("pmc-1", "Add feature", "2026-09-15T00:00:00Z"), release: "2026.09.18" },
      ];
      const opts = {
        items,
        releaseWindows: [
          { heading: "2026.9.18 - 2026-09-18", releaseTag: "v2026.09.18", until: "2026-09-18T00:00:00Z" },
        ],
      };

      const without = createChangelog(opts);
      const withFlag = createChangelog({ ...opts, dependencyUpdates: true, gitCwd: dir });

      equal(withFlag.markdown, without.markdown, "output must be byte-identical when no dependency commits exist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("without the flag, does NOT include dependency commits even when they exist in git", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "feat: add feature", "2026-09-15T10:00:00Z");
      commitIn(dir, "build(deps): bump jscpd from 5.2.0 to 5.3.0 (#129)", "2026-09-16T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.18"]);

      const items = [
        { ...closedItem("pmc-1", "Add feature", "2026-09-15T00:00:00Z"), release: "2026.09.18" },
      ];
      const result = createChangelog({
        items,
        releaseWindows: [
          { heading: "2026.9.18 - 2026-09-18", releaseTag: "v2026.09.18", until: "2026-09-18T00:00:00Z" },
        ],
        // No dependencyUpdates flag — git commits must be ignored.
      });

      ok(!result.markdown.includes("### Dependencies"), "must not have a Dependencies section without the flag");
      ok(!result.markdown.includes("Bump jscpd"), "must not include dependency commit text without the flag");
      ok(result.markdown.includes("Add feature"), "must still include pm items");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with the flag but no gitCwd, produces output identical to without the flag", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "build(deps): bump jscpd from 5.2.0 to 5.3.0 (#129)", "2026-09-20T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.23"]);

      const opts = {
        items: [] as PmItem[],
        version: "2026.09.23",
        date: "2026-09-23",
        since: "2026-09-20T00:00:00Z",
        until: "2026-09-23T23:59:59Z",
      };

      const without = createChangelog(opts);
      // dependencyUpdates is true but gitCwd is not set — enrichment is skipped
      const withFlagNoCwd = createChangelog({ ...opts, dependencyUpdates: true });

      equal(withFlagNoCwd.markdown, without.markdown, "output with flag but no gitCwd must be byte-identical to without flag");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Non-repository / error handling
// ---------------------------------------------------------------------------

describe("dependency-updates: error handling", () => {
  it("returns no dependency commits when gitCwd is not a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-changelog-deps-nogit-"));
    try {
      const result = createChangelog({
        items: [],
        version: "2026.09.23",
        date: "2026-09-23",
        dependencyUpdates: true,
        gitCwd: dir,
      });

      // Should not crash, just produce an empty changelog (no sections)
      ok(result.markdown.includes("# Changelog"), "must still produce the title");
      ok(!result.markdown.includes("### Dependencies"), "must not have a Dependencies section from a non-repo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty commits when no since/until boundaries are available", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "build(deps): bump jscpd from 5.2.0 to 5.3.0 (#129)", "2026-09-20T10:00:00Z");

      const result = createChangelog({
        items: [],
        version: "2026.09.23",
        date: "2026-09-23",
        // No since/until, no releaseWindows — git log has no range
        dependencyUpdates: true,
        gitCwd: dir,
      });

      // No range → no commits → no Dependencies section, but also no items →
      // the single-version section renders "No changes." (includeEmpty is off
      // by default so the section is filtered out; the result is title-only).
      ok(result.markdown.includes("# Changelog"), "must still produce the title");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty commits when git fails on a non-repository with a range", () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-changelog-deps-nogit-range-"));
    try {
      // A non-git directory with since/until boundaries: readDependencyCommits
      // constructs a git log --since/--until command, git fails, and the catch
      // block returns an empty array.
      const result = createChangelog({
        items: [],
        version: "2026.09.23",
        date: "2026-09-23",
        since: "2026-09-20T00:00:00Z",
        until: "2026-09-23T23:59:59Z",
        dependencyUpdates: true,
        gitCwd: dir,
      });

      ok(result.markdown.includes("# Changelog"), "must still produce the title");
      ok(!result.markdown.includes("### Dependencies"), "must not have a Dependencies section when git fails");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders a commit without a PR number as a plain bullet", () => {
    const dir = gitRepo();
    try {
      // A Dependabot subject without a trailing (#NNN)
      commitIn(dir, "build(deps): bump taiki-e/install-action from 2.87.16 to 2.87.18", "2026-09-20T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.23"]);

      const result = createChangelog({
        items: [],
        version: "2026.09.23",
        date: "2026-09-23",
        since: "2026-09-20T00:00:00Z",
        until: "2026-09-23T23:59:59Z",
        dependencyUpdates: true,
        gitCwd: dir,
      });

      ok(result.markdown.includes("Bump taiki-e/install-action from 2.87.16 to 2.87.18"), "must list the no-PR commit");
      ok(!result.markdown.includes("(#"), "must not include a PR reference when none is present");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads commits with only --since (no --until)", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "build(deps): bump jscpd from 5.2.0 to 5.3.0 (#129)", "2026-09-20T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.23"]);

      const result = createChangelog({
        items: [],
        version: "2026.09.23",
        date: "2026-09-23",
        since: "2026-09-20T00:00:00Z",
        // No until — exercises the sinceTimestamp-only branch
        dependencyUpdates: true,
        gitCwd: dir,
      });

      ok(result.markdown.includes("Bump jscpd"), "must collect commits with only --since");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads commits with only --until (no --since)", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "build(deps): bump jscpd from 5.2.0 to 5.3.0 (#129)", "2026-09-20T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.23"]);

      const result = createChangelog({
        items: [],
        version: "2026.09.23",
        date: "2026-09-23",
        // No since — exercises the untilTimestamp-only branch
        until: "2026-09-23T23:59:59Z",
        dependencyUpdates: true,
        gitCwd: dir,
      });

      ok(result.markdown.includes("Bump jscpd"), "must collect commits with only --until");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses single-window mode when releaseWindows is an empty array", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "build(deps): bump jscpd from 5.2.0 to 5.3.0 (#129)", "2026-09-20T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.23"]);

      const result = createChangelog({
        items: [],
        version: "2026.09.23",
        date: "2026-09-23",
        since: "2026-09-20T00:00:00Z",
        until: "2026-09-23T23:59:59Z",
        // An empty (non-suppressed) releaseWindows array falls back to
        // single-version section mode, and enrichment uses single-window mode.
        releaseWindows: [],
        dependencyUpdates: true,
        gitCwd: dir,
      });

      ok(result.markdown.includes("Bump jscpd"), "must collect commits in single-window mode with empty releaseWindows");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
// ---------------------------------------------------------------------------
// Review round 1 (Greptile, pm-changelog#210): exact ranges and every output
// ---------------------------------------------------------------------------
describe("dependency-updates: release ranges and outputs", () => {
  it("rejects deps-scoped commits that are not Dependabot bumps", () => {
    equal(parseDependencyCommit("fix(deps): correct loader (#7)"), undefined);
    equal(parseDependencyCommit("chore(deps): pin the lockfile"), undefined);
    ok(parseDependencyCommit("chore(deps): bump yaml from 2.9.0 to 2.9.1 (#130)"));
  });

  it("reads a pending release, whose tag does not exist yet, up to HEAD", () => {
    const dir = gitRepo();
    try {
      gitIn(dir, ["tag", "v2026.09.18"]);
      commitIn(dir, "build(deps-dev): bump jscpd from 5.2.0 to 5.3.0 (#129)");
      const result = createChangelog({
        items: [],
        releaseWindows: [
          { heading: "2026.9.25 - 2026-09-25", releaseTag: "v2026.09.25", since: "2026-09-18T00:00:00Z", sinceExclusive: true },
          { heading: "2026.9.18 - 2026-09-18", releaseTag: "v2026.09.18" },
        ],
        dependencyUpdates: true,
        gitCwd: dir,
      });
      ok(result.markdown.includes("## 2026.9.25 - 2026-09-25\n\n### Dependencies\n\n- Bump jscpd"), result.markdown);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds a single release by its tags, not by commit dates", () => {
    const dir = gitRepo();
    try {
      // Tagged ON a dependency commit: the previous release shipped it.
      commitIn(dir, "build(deps): bump yaml from 2.9.0 to 2.9.1 (#130)", "2026-09-18T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.18"]);
      commitIn(dir, "build(deps-dev): bump jscpd from 5.2.0 to 5.3.0 (#129)", "2026-09-19T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.23"]);
      // After the release, but dated inside its window.
      commitIn(dir, "build(deps-dev): bump @types/node from 26.5.1 to 26.6.2 (#132)", "2026-09-20T10:00:00Z");
      const result = createChangelog({
        items: [],
        version: "2026.9.23",
        date: "2026-09-23",
        since: "2026-09-18T10:00:00Z",
        until: "2026-09-23T00:00:00Z",
        dependencyUpdates: true,
        gitCwd: dir,
        dependencySinceRef: "v2026.09.18",
        dependencyUntilRef: "v2026.09.23",
      });
      ok(result.markdown.includes("Bump jscpd"), result.markdown);
      ok(!result.markdown.includes("Bump yaml"), "the previous release's own commit must not repeat");
      ok(!result.markdown.includes("Bump @types/node"), "a commit after the release tag must not leak in");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the window's time bounds within the newer tag's history when the older tag is orphaned", () => {
    const dir = gitRepo();
    try {
      // An orphaned tag: on a side branch the release history never contains.
      gitIn(dir, ["checkout", "--quiet", "-b", "rewritten"]);
      commitIn(dir, "build(deps): bump orphan from 1.0.0 to 1.0.1 (#1)", "2026-09-10T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.10"]);
      gitIn(dir, ["checkout", "--quiet", "main"]);
      commitIn(dir, "build(deps): bump early from 1.0.0 to 1.0.1 (#2)", "2026-09-05T10:00:00Z");
      commitIn(dir, "build(deps): bump inside from 1.0.0 to 1.0.1 (#3)", "2026-09-12T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.15"]);
      const windows = [
        { heading: "2026.9.15 - 2026-09-15", releaseTag: "v2026.09.15", since: "2026-09-10T12:00:00Z", sinceExclusive: true, until: "2026-09-15T00:00:00Z" },
        { heading: "2026.9.10 - 2026-09-10", releaseTag: "v2026.09.10", until: "2026-09-10T12:00:00Z" },
      ];
      const result = createChangelog({ items: [], releaseWindows: windows, dependencyUpdates: true, gitCwd: dir });
      const newest = result.markdown.slice(result.markdown.indexOf("## 2026.9.15"), result.markdown.indexOf("## 2026.9.10"));
      ok(newest.includes("Bump inside"), result.markdown);
      ok(!newest.includes("Bump early"), "a commit dated before the window must stay out");
      ok(!newest.includes("Bump orphan"), "a commit outside the newer tag's history must stay out");
      // Without time bounds an orphaned start leaves no safe window at all.
      const unbounded = createChangelog({
        items: [],
        releaseWindows: [{ ...windows[0], since: undefined }, windows[1]],
        dependencyUpdates: true,
        gitCwd: dir,
      });
      ok(!unbounded.markdown.includes("Bump inside"), unbounded.markdown);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escapes markdown in commit descriptions, keeping the generated PR link", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "build(deps): bump [evil](https://evil.example) from *1* to _2_ (#9)");
      const result = createChangelog({
        items: [],
        version: "1.0.0",
        dependencyUpdates: true,
        gitCwd: dir,
        itemUrlBase: "https://github.com/unbraind/pm-csv/blob/main/.agents/pm",
      });
      ok(result.markdown.includes("- Bump \\[evil\\](https://evil.example) from \\*1\\* to \\_2\\_ ([#9](https://github.com/unbraind/pm-csv/pull/9))"), result.markdown);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves release and milestone grouping without dependency sections", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "build(deps): bump yaml from 2.9.0 to 2.9.1 (#130)");
      const items = [{ ...closedItem("pmc-1", "Grouped item", "2026-09-15T00:00:00Z"), release: "1.0.0" }];
      for (const groupBy of ["release", "milestone"] as const) {
        const result = createChangelog({ items, groupBy, dependencyUpdates: true, gitCwd: dir });
        ok(!result.markdown.includes("### Dependencies"), result.markdown);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists dependency-only releases in the structured document and the summary", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "build(deps): bump yaml from 2.9.0 to 2.9.1 (#130)");
      commitIn(dir, "chore(deps): bump the codeql-action group with 2 updates");
      const options = { items: [], version: "1.0.0", date: "2026-09-25", dependencyUpdates: true, gitCwd: dir };
      const document = buildChangelogDocument(options);
      equal(document.releases.length, 1);
      equal(document.releases[0].item_count, 0);
      equal(JSON.stringify(document.releases[0].dependencies), JSON.stringify([
        { subject: "chore(deps): bump the codeql-action group with 2 updates", description: "Bump the codeql-action group with 2 updates" },
        { subject: "build(deps): bump yaml from 2.9.0 to 2.9.1 (#130)", description: "Bump yaml from 2.9.0 to 2.9.1", pr_number: 130 },
      ]));
      const summary = createChangelogSummary(options);
      equal(JSON.stringify(summary.map((entry) => [entry.category, entry.id, entry.title])), JSON.stringify([
        ["Dependencies", undefined, "Bump the codeql-action group with 2 updates"],
        ["Dependencies", "#130", "Bump yaml from 2.9.0 to 2.9.1"],
      ]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dependency-updates: an explicit --until cutoff", () => {
  it("bounds a tagged release and a pending one, as it bounds their items", () => {
    const dir = gitRepo();
    try {
      commitIn(dir, "feat: base", "2026-09-10T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.10"]);
      commitIn(dir, "build(deps): bump before from 1.0.0 to 1.0.1 (#1)", "2026-09-12T10:00:00Z");
      commitIn(dir, "build(deps): bump after from 1.0.0 to 1.0.1 (#2)", "2026-09-14T10:00:00Z");
      gitIn(dir, ["tag", "v2026.09.15"]);
      const base = { items: [], version: "2026.9.15", dependencyUpdates: true, gitCwd: dir, dependencySinceRef: "v2026.09.10", until: "2026-09-13T00:00:00Z" };
      for (const dependencyUntilRef of ["v2026.09.15", "v2026.09.99"]) {
        const result = createChangelog({ ...base, dependencyUntilRef });
        ok(result.markdown.includes("Bump before"), result.markdown);
        ok(!result.markdown.includes("Bump after"), `a commit after --until must stay out (${dependencyUntilRef})`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
