import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  buildPmListArgs,
  createChangelog,
  explainChangelogSelection,
  IncompleteListAllError,
  mergeChangelog,
  MISSING_TAG_HISTORY_ERROR_CODE,
  MissingTagHistoryError,
  parseListAllItemsJson,
  type PmItem,
  readPmItems,
  resolveReleaseContext,
  resolveReleaseTagWindows,
  resolveReleaseTagWindowResolution,
  writeChangelog,
} from "../src/index.ts";

function readEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  key: string,
  caseInsensitive = process.platform === "win32"
): string | undefined {
  if (!caseInsensitive) return environment[key];
  const normalizedKey = key.toUpperCase();
  return Object.entries(environment).find(
    ([candidate]) => candidate.toUpperCase() === normalizedKey
  )?.[1];
}

test("readEnvironmentValue preserves Windows case-insensitive lookup semantics", () => {
  const environment = { SYSTEMROOT: "C:\\Windows" };
  assert.equal(readEnvironmentValue(environment, "SystemRoot", true), "C:\\Windows");
  assert.equal(readEnvironmentValue(environment, "SystemRoot", false), undefined);
});

const items = [
  {
    id: "pm-2",
    title: "Fix runner status export",
    status: "closed",
    type: "bug",
    release: "1.2.0",
    updated_at: "2026-05-17T09:00:00Z",
  },
  {
    id: "pm-1",
    title: "Add GitHub Actions changelog command",
    status: "closed",
    type: "feature",
    metadata: {
      release: "1.2.0",
    },
    updated_at: "2026-05-16T09:00:00Z",
  },
  {
    id: "pm-3",
    title: "Draft release notes",
    status: "open",
    type: "task",
    updated_at: "2026-05-17T11:00:00Z",
  },
];

test("buildPmListArgs centralizes canonical pm runner argument order", () => {
  assert.deepEqual(buildPmListArgs({
    pmRoot: ".agents/pm",
    pmArgs: [
      "--profile", "ci",
      "--output-budget", "1",
      "--output-limit", "1",
    ],
    includeBody: true,
  }), [
    "--pm-path", ".agents/pm",
    "--profile", "ci",
    "--output-budget", "1",
    "--output-limit", "1",
    "--output-budget", "unbounded",
    "--output-limit", "unbounded",
    "list", "--all", "--json", "--include-body",
  ]);
});

test("createChangelog groups closed items by category", () => {
  const result = createChangelog({
    items,
    version: "1.2.0",
    date: "2026-05-17",
  });

  assert.equal(result.itemCount, 2);
  assert.match(result.markdown, /^# Changelog\n\n## 1\.2\.0 - 2026-05-17/m);
  assert.match(result.markdown, /### Added\n\n- Add GitHub Actions changelog command \(pm-1\)/);
  assert.match(result.markdown, /### Fixed\n\n- Fix runner status export \(pm-2\)/);
  assert.doesNotMatch(result.markdown, /Draft release notes/);
});

test("createChangelog does not derive a version heading date from the wall clock", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-01T22:30:00.000Z") });
  try {
    const firstDay = createChangelog({ items, version: "1.2.0" }).markdown;
    context.mock.timers.setTime(Date.parse("2026-09-01T02:00:00.000Z"));
    const secondDay = createChangelog({ items, version: "1.2.0" }).markdown;

    assert.equal(secondDay, firstDay, "identical inputs must survive a change in simulated today");
    assert.match(firstDay, /^# Changelog\n\n## 1\.2\.0$/m);
    assert.doesNotMatch(firstDay, /^## 1\.2\.0 - /m);
  } finally {
    context.mock.timers.reset();
  }
});

test("createChangelog keeps harmless title punctuation readable", () => {
  const result = createChangelog({
    items: [
      {
        id: "pm-clean-title",
        title: "Fix EXTENSION_AUTHOR_CONTRACTS docs (actual 1.4.0) and _ marker plus _secret_",
        status: "closed",
        type: "bug",
        updated_at: "2026-06-19T09:00:00Z",
      },
    ],
    version: "1.2.0",
    date: "2026-06-19",
  });

  assert.match(result.markdown, /EXTENSION_AUTHOR_CONTRACTS docs \(actual 1\.4\.0\)/);
  assert.doesNotMatch(result.markdown, /EXTENSION\\_AUTHOR\\_CONTRACTS|\\\(actual 1\.4\.0\\\)/);
  assert.match(result.markdown, /and \\_ marker/);
  assert.match(result.markdown, /plus \\_secret\\_/);
});

test("createChangelog preserves inline code in item titles", () => {
  const result = createChangelog({
    items: [
      {
        id: "pm-inline-code",
        title: "Dogfood: pm-kanban registers kanbanProfile so `pm profile apply kanban --flag [x]` works with _ marker",
        status: "closed",
        type: "task",
        updated_at: "2026-06-29T09:00:00Z",
      },
    ],
    version: "1.2.0",
    date: "2026-06-29",
  });

  assert.match(
    result.markdown,
    /so `pm profile apply kanban --flag \[x\]` works with \\_ marker \(pm-inline-code\)/
  );
  assert.doesNotMatch(result.markdown, /\\`pm profile apply kanban/);
  assert.doesNotMatch(result.markdown, /--flag \\\[x\\\]/);
});

test("createChangelog escapes unmatched backticks in item titles", () => {
  const result = createChangelog({
    items: [
      {
        id: "pm-unmatched-code",
        title: "Fix unmatched ` marker before [metadata]",
        status: "closed",
        type: "bug",
        updated_at: "2026-06-29T10:00:00Z",
      },
    ],
    version: "1.2.0",
    date: "2026-06-29",
  });

  assert.match(result.markdown, /Fix unmatched \\` marker before \\\[metadata\\\] \(pm-unmatched-code\)/);
});

test("createChangelog can group items by release metadata", () => {
  const result = createChangelog({
    items: [
      ...items,
      {
        id: "pm-4",
        title: "Improve release note rendering",
        status: "closed",
        type: "task",
        release: "1.1.0",
        updated_at: "2026-05-15T09:00:00Z",
      },
    ],
    date: "2026-05-17",
    groupBy: "release",
  });

  assert.equal(result.itemCount, 3);
  assert.match(result.markdown, /## 1\.2\.0\n\n### Added[\s\S]*## 1\.1\.0\n\n### Changed/);
  assert.match(result.markdown, /- Improve release note rendering \(pm-4\)/);
});

test("createChangelog can build full history from git tag windows", () => {
  const result = createChangelog({
    items: [
      {
        id: "pm-post",
        title: "Document post-release cleanup",
        status: "closed",
        type: "task",
        closed_at: "2026-05-18T12:00:00Z",
      },
      {
        id: "pm-current",
        title: "Add release window generation",
        status: "closed",
        type: "feature",
        closed_at: "2026-05-17T12:00:00Z",
      },
      {
        id: "pm-previous",
        title: "Fix previous release notes",
        status: "closed",
        type: "bug",
        closed_at: "2026-05-10T12:00:00Z",
      },
    ],
    releaseWindows: [
      { heading: "Unreleased", since: "2026-05-17T13:00:00Z", sinceExclusive: true },
      {
        heading: "1.2.0 - 2026-05-17",
        since: "2026-05-10T13:00:00Z",
        sinceExclusive: true,
        until: "2026-05-17T13:00:00Z",
      },
      { heading: "1.1.0 - 2026-05-10", until: "2026-05-10T13:00:00Z" },
    ],
  });

  assert.equal(result.itemCount, 3);
  assert.match(result.markdown, /## Unreleased[\s\S]*Document post-release cleanup \(pm-post\)/);
  assert.match(result.markdown, /## 1\.2\.0 - 2026-05-17[\s\S]*Add release window generation \(pm-current\)/);
  assert.match(result.markdown, /## 1\.1\.0 - 2026-05-10[\s\S]*Fix previous release notes \(pm-previous\)/);
  assert.doesNotMatch(
    result.markdown.match(/## 1\.2\.0 - 2026-05-17[\s\S]*?(?=## 1\.1\.0)/)?.[0] ?? "",
    /pm-previous/
  );
});

test("createChangelog prefers actual completion time and preserves the legacy close-time fallback", () => {
  const result = createChangelog({
    items: [
      {
        id: "pm-actual",
        title: "Completed before delayed tracker closeout",
        status: "closed",
        type: "feature",
        completed_at: "2026-05-17T12:00:00Z",
        closed_at: "2026-05-18T12:00:00Z",
      },
      {
        id: "pm-legacy",
        title: "Legacy item without actual completion",
        status: "closed",
        type: "bug",
        closed_at: "2026-05-18T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      },
      {
        id: "pm-completed-only",
        title: "Completed item without tracker close time",
        status: "closed",
        type: "task",
        completed_at: "2026-05-17T11:00:00Z",
      },
    ],
    releaseWindows: [
      {
        heading: "Unreleased",
        since: "2026-05-17T13:00:00Z",
        sinceExclusive: true,
      },
      {
        heading: "1.2.0 - 2026-05-17",
        until: "2026-05-17T13:00:00Z",
      },
    ],
  });

  const released =
    result.markdown.match(
      /## 1\.2\.0 - 2026-05-17[\s\S]*?(?=\n## |$)/,
    )?.[0] ?? "";
  const unreleased =
    result.markdown.match(/## Unreleased[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  assert.match(released, /Completed before delayed tracker closeout/);
  assert.match(released, /Completed item without tracker close time/);
  assert.doesNotMatch(released, /Legacy item without actual completion/);
  assert.match(unreleased, /Legacy item without actual completion/);
});

test("createChangelog keeps a sub-second item inside the release second it closed in", () => {
  // Regression for issue #41: git release-tag boundaries are second-precision
  // while pm items carry millisecond `closed_at`. An item closed at
  // 13:00:00.789 must stay in the release whose tag landed at 13:00:00, not
  // resurface under Unreleased.
  const result = createChangelog({
    items: [
      {
        id: "pm-boundary",
        title: "Closed in the same second the tag landed",
        status: "closed",
        type: "feature",
        closed_at: "2026-05-17T13:00:00.789Z",
      },
    ],
    releaseWindows: [
      { heading: "Unreleased", since: "2026-05-17T13:00:00Z", sinceExclusive: true },
      { heading: "1.2.0 - 2026-05-17", since: "2026-05-10T13:00:00Z", sinceExclusive: true, until: "2026-05-17T13:00:00Z" },
    ],
  });

  assert.equal(result.itemCount, 1);
  const v120 = result.markdown.match(/## 1\.2\.0 - 2026-05-17[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  assert.match(v120, /Closed in the same second the tag landed \(pm-boundary\)/);
  const unreleased = result.markdown.match(/## Unreleased[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  assert.doesNotMatch(unreleased, /pm-boundary/);
});

test("createChangelog non-exclusive since admits items in the same boundary second", () => {
  // Documents the intentional second-granularity consequence (issue #41): a
  // sub-second `--since` boundary admits items closed earlier in that same
  // second, since release-tag boundaries are always second-precision.
  const result = createChangelog({
    items: [
      {
        id: "pm-same-second",
        title: "Closed earlier in the since boundary second",
        status: "closed",
        type: "task",
        closed_at: "2026-05-10T13:00:00.000Z",
      },
    ],
    since: "2026-05-10T13:00:00.500Z",
  });

  assert.equal(result.itemCount, 1);
  assert.match(result.markdown, /Closed earlier in the since boundary second \(pm-same-second\)/);
});

test("createChangelog buckets items by release field when window has releaseTag", () => {
  const result = createChangelog({
    items: [
      {
        id: "pm-late-stamp",
        title: "Item stamped after release",
        status: "closed",
        type: "feature",
        release: "v1.2.0",
        updated_at: "2026-05-25T12:00:00Z",
      },
      {
        id: "pm-recent",
        title: "Item without release field",
        status: "closed",
        type: "bug",
        closed_at: "2026-05-20T12:00:00Z",
      },
    ],
    releaseWindows: [
      {
        heading: "Unreleased",
        since: "2026-05-17T13:00:00Z",
        sinceExclusive: true,
      },
      {
        heading: "1.2.0 - 2026-05-17",
        releaseTag: "v1.2.0",
        until: "2026-05-17T13:00:00Z",
      },
    ],
  });

  assert.equal(result.itemCount, 2);
  const v120 = result.markdown.match(/## 1\.2\.0 - 2026-05-17[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  assert.match(v120, /Item stamped after release \(pm-late-stamp\)/);
  assert.doesNotMatch(v120, /pm-recent/);
  const unreleased = result.markdown.match(/## Unreleased[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  assert.match(unreleased, /Item without release field \(pm-recent\)/);
  assert.doesNotMatch(unreleased, /pm-late-stamp/);
});

test("createChangelog preserves historical sections with orphaned-git-tag boundaries", () => {
  // Regression: --all-release-tags must include orphaned (non-merged) release
  // tags so items from different months are assigned to the correct historical
  // windows instead of collapsing into the oldest reachable window.
  const result = createChangelog({
    items: [
      {
        id: "pm-old",
        title: "Old task from May",
        status: "closed",
        type: "task",
        updated_at: "2026-05-10T12:00:00Z",
      },
      {
        id: "pm-mid",
        title: "Mid-cycle feature",
        status: "closed",
        type: "feature",
        updated_at: "2026-05-20T12:00:00Z",
        release: "v2026.5.20",
      },
      {
        id: "pm-new",
        title: "New fix in current window",
        status: "closed",
        type: "bug",
        closed_at: "2026-06-01T11:00:00Z",
      },
    ],
    releaseWindows: [
      { heading: "Unreleased", since: "2026-06-01T13:00:00Z", sinceExclusive: true },
      {
        heading: "2026.6.1 - 2026-06-01",
        releaseTag: "v2026.6.1",
        since: "2026-05-20T13:00:00Z",
        sinceExclusive: true,
        until: "2026-06-01T13:00:00Z",
      },
      {
        heading: "2026.5.20 - 2026-05-20",
        releaseTag: "v2026.5.20",
        since: "2026-05-10T13:00:00Z",
        sinceExclusive: true,
        until: "2026-05-20T13:00:00Z",
      },
      // Orphaned tag: items before v2026.5.20 and not matched by release
      // metadata fall into this window via time-based assignment.
      { heading: "2026.5.10 - 2026-05-10", until: "2026-05-10T13:00:00Z" },
    ],
  });

  assert.equal(result.itemCount, 3);
  // pm-mid matches releaseTag v2026.5.20 by explicit release field
  const v520 = result.markdown.match(/## 2026\.5\.20 - 2026-05-20[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  assert.match(v520, /Mid-cycle feature \(pm-mid\)/);
  // pm-new is correctly in the 2026.6.1 window by closed_at timestamp
  const v61 = result.markdown.match(/## 2026\.6\.1 - 2026-06-01[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  assert.match(v61, /New fix in current window \(pm-new\)/);
  // pm-old is in the May 10 window (time-based)
  const v510 = result.markdown.match(/## 2026\.5\.10 - 2026-05-10[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  assert.match(v510, /Old task from May \(pm-old\)/);
  // The old window and mid window are preserved (not collapsed)
  assert.ok(result.markdown.includes("## 2026.5.10 - 2026-05-10"));
  assert.ok(result.markdown.includes("## 2026.5.20 - 2026-05-20"));
  assert.ok(result.markdown.includes("## 2026.6.1 - 2026-06-01"));
  // Unreleased gets the timestamp-less item if one is created
  // (no unreleased items expected here)
});

test("createChangelog preserves empty release windows when includeEmpty is set", () => {
  const result = createChangelog({
    items: [],
    releaseWindows: [
      { heading: "Unreleased", since: "2026-05-18T12:00:00Z", sinceExclusive: true },
      { heading: "1.2.0 - 2026-05-17", until: "2026-05-17T12:00:00Z" },
    ],
    includeEmpty: true,
  });

  assert.equal(result.itemCount, 0);
  assert.match(result.markdown, /## Unreleased\n\nNo changes\./);
  assert.match(result.markdown, /## 1\.2\.0 - 2026-05-17\n\nNo changes\./);
});

test("createChangelog omits empty release windows by default", () => {
  const result = createChangelog({
    items: [
      {
        id: "pm-1",
        title: "Add release window generation",
        status: "closed",
        type: "feature",
        closed_at: "2026-05-17T12:00:00Z",
      },
    ],
    releaseWindows: [
      { heading: "Unreleased", since: "2026-05-17T13:00:00Z", sinceExclusive: true },
      { heading: "1.2.0 - 2026-05-17", until: "2026-05-17T13:00:00Z" },
    ],
  });

  assert.equal(result.itemCount, 1);
  assert.doesNotMatch(result.markdown, /## Unreleased/);
  assert.match(result.markdown, /## 1\.2\.0 - 2026-05-17[\s\S]*pm-1/);
});

test("resolveReleaseTagWindows derives newest-first git tag windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-tags-"));
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "pm changelog test"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "pm-changelog@example.com"], { cwd: dir, encoding: "utf-8" });
  const defaultBranch = execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf-8" }).trim();

  writeFileSync(join(dir, "file.txt"), "one\n");
  execFileSync("git", ["add", "file.txt"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "one"], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-05-10T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-05-10T12:00:00Z",
    },
  });
  execFileSync("git", ["tag", "v1.1.0"], { cwd: dir, encoding: "utf-8" });

  execFileSync("git", ["switch", "-c", "side-release"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(join(dir, "side.txt"), "side\n");
  execFileSync("git", ["add", "side.txt"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "side"], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-05-30T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-05-30T12:00:00Z",
    },
  });
  execFileSync("git", ["tag", "v9.9.9"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["switch", defaultBranch], { cwd: dir, encoding: "utf-8" });

  writeFileSync(join(dir, "file.txt"), "two\n");
  execFileSync("git", ["add", "file.txt"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "two"], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-05-17T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-05-17T12:00:00Z",
    },
  });
  execFileSync("git", ["tag", "-a", "v1.2.0", "-m", "two"], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_COMMITTER_DATE: "2026-05-20T12:00:00Z",
    },
  });

  const windows = resolveReleaseTagWindows({
    cwd: dir,
    pendingVersion: "1.3.0",
    pendingTimestamp: "2026-05-20 12:00:00 +0000",
  });

  assert.equal(windows.length, 3);
  assert.equal(windows[0].heading, "1.3.0 - 2026-05-20");
  assert.equal(windows[0].since, "2026-05-17T12:00:00.000Z");
  assert.equal(windows[0].until, undefined);
  assert.equal(windows[1].heading, "1.2.0 - 2026-05-17");
  assert.equal(windows[1].since, "2026-05-10T12:00:00.000Z");
  assert.equal(windows[1].until, "2026-05-17T12:00:00.000Z");
  assert.equal(windows[2].heading, "1.1.0 - 2026-05-10");
  assert.ok(windows.every((window) => !window.heading.startsWith("9.9.9")));
});

test("resolveReleaseTagWindows includes orphaned tags only when opted in", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-orphan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "pm changelog test"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "pm-changelog@example.com"], { cwd: dir, encoding: "utf-8" });
  const defaultBranch = execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf-8" }).trim();

  // Create a commit and tag on main (reachable).
  writeFileSync(join(dir, "file.txt"), "main\n");
  execFileSync("git", ["add", "file.txt"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "main"], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-06-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-06-01T12:00:00Z" },
  });
  execFileSync("git", ["tag", "v2026.6.1"], { cwd: dir, encoding: "utf-8" });

  // Create an orphaned branch with a release tag (simulates rebase/squash).
  execFileSync("git", ["switch", "--orphan", "old-history"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(join(dir, "old.txt"), "old\n");
  execFileSync("git", ["add", "old.txt"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "old"], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-05-15T12:00:00Z", GIT_COMMITTER_DATE: "2026-05-15T12:00:00Z" },
  });
  execFileSync("git", ["tag", "v2026.5.15"], { cwd: dir, encoding: "utf-8" });

  // Switch back to main — the orphaned tag should still be found.
  execFileSync("git", ["switch", defaultBranch], { cwd: dir, encoding: "utf-8" });

  const windows = resolveReleaseTagWindows({ cwd: dir, includeOrphaned: true });

  // Should include both the reachable (v2026.6.1) and the orphaned (v2026.5.15) tag.
  assert.equal(windows.length, 3);
  assert.equal(windows[0].heading, "Unreleased");
  assert.equal(windows[1].heading, "2026.6.1 - 2026-06-01");
  assert.equal(windows[2].heading, "2026.5.15 - 2026-05-15");
});

test("resolveReleaseTagWindows keeps unpadded calendar pending headings", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-calver-"));
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "pm changelog test"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "pm-changelog@example.com"], { cwd: dir, encoding: "utf-8" });

  writeFileSync(join(dir, "file.txt"), "one\n");
  execFileSync("git", ["add", "file.txt"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "one"], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-05-24T12:00:00Z", GIT_COMMITTER_DATE: "2026-05-24T12:00:00Z" },
  });
  // Legacy zero-padded tag, as published before the unpadded convention.
  execFileSync("git", ["tag", "v2026.05.24"], { cwd: dir, encoding: "utf-8" });

  const windows = resolveReleaseTagWindows({
    cwd: dir,
    pendingVersion: "2026.5.27",
    pendingTimestamp: "2026-05-27 12:00:00 +0000",
  });

  assert.equal(windows.length, 2);
  // The pending heading must echo the caller's unpadded YYYY.M.D version so the
  // pm-cli release pipeline can locate the `## 2026.5.27` section it asked for.
  assert.equal(windows[0].heading, "2026.5.27 - 2026-05-27");
  assert.doesNotMatch(windows[0].heading, /2026\.05\.27/);
  // A leading open-ended pending window replaces Unreleased so an item cannot
  // be claimed by both sections.
  assert.equal(windows[0].until, undefined);
  // Padded calendar tags render unpadded headings too, so the post-tag heading
  // matches the pre-tag pending heading and the committed CHANGELOG (issue #41).
  assert.equal(windows[1].heading, "2026.5.24 - 2026-05-24");
});

test("resolveReleaseTagWindows dedupes a pending version against a padded tag", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-dedupe-"));
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "pm changelog test"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "pm-changelog@example.com"], { cwd: dir, encoding: "utf-8" });

  writeFileSync(join(dir, "file.txt"), "one\n");
  execFileSync("git", ["add", "file.txt"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "one"], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-05-24T12:00:00Z", GIT_COMMITTER_DATE: "2026-05-24T12:00:00Z" },
  });
  execFileSync("git", ["tag", "v2026.05.24"], { cwd: dir, encoding: "utf-8" });

  // Unpadded pending version for a date already tagged in padded form: the
  // candidate set must match the existing tag so no duplicate window appears.
  const windows = resolveReleaseTagWindows({
    cwd: dir,
    pendingVersion: "2026.5.24",
    pendingTimestamp: "2026-05-24 12:00:00 +0000",
  });

  assert.equal(windows.length, 2);
  assert.equal(windows[0].heading, "Unreleased");
  assert.equal(windows[1].heading, "2026.5.24 - 2026-05-24");
});

test("resolveReleaseTagWindows renders a padded calendar tag with an unpadded heading", () => {
  // Regression for issue #41: the pm-cli release pipeline tags releases in
  // zero-padded form (`v2026.06.09`) but commits unpadded `## 2026.6.9`
  // headings pre-tag. The post-tag regeneration must reproduce the unpadded
  // heading or `changelog:check` fails on every released repo at HEAD.
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-padded-heading-"));
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "pm changelog test"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "pm-changelog@example.com"], { cwd: dir, encoding: "utf-8" });

  writeFileSync(join(dir, "file.txt"), "one\n");
  execFileSync("git", ["add", "file.txt"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "one"], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-06-09T12:00:00Z", GIT_COMMITTER_DATE: "2026-06-09T12:00:00Z" },
  });
  execFileSync("git", ["tag", "v2026.06.09"], { cwd: dir, encoding: "utf-8" });

  // No pending version: the heading is derived purely from the existing tag.
  const windows = resolveReleaseTagWindows({ cwd: dir, includeUnreleased: false });

  assert.equal(windows.length, 1);
  assert.equal(windows[0].releaseTag, "v2026.06.09");
  assert.equal(windows[0].heading, "2026.6.9 - 2026-06-09");
  assert.doesNotMatch(windows[0].heading, /2026\.06\.09/);
});

test("resolveReleaseTagWindows preserves a pre-release suffix while unpadding", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-padded-suffix-"));
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "pm changelog test"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "pm-changelog@example.com"], { cwd: dir, encoding: "utf-8" });

  writeFileSync(join(dir, "file.txt"), "one\n");
  execFileSync("git", ["add", "file.txt"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "one"], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-06-09T12:00:00Z", GIT_COMMITTER_DATE: "2026-06-09T12:00:00Z" },
  });
  execFileSync("git", ["tag", "v2026.06.09-1"], { cwd: dir, encoding: "utf-8" });

  const windows = resolveReleaseTagWindows({ cwd: dir, includeUnreleased: false });

  assert.equal(windows.length, 1);
  assert.equal(windows[0].heading, "2026.6.9-1 - 2026-06-09");
});

test("createChangelog omits item links unless explicitly enabled", () => {
  const result = createChangelog({
    items: [
      {
        id: "pm-5",
        title: "Fix multiline\nrelease title",
        status: "closed",
        type: "bug",
        url: "https://user@example.com/unbraind/pm-changelog/issues/5",
        updated_at: "2026-05-17T10:00:00Z",
      },
    ],
    version: "1.2.0",
    date: "2026-05-17",
  });

  assert.match(result.markdown, /- Fix multiline release title \(pm-5\)$/m);
  assert.doesNotMatch(result.markdown, /example\.com|user/);

  const linked = createChangelog({
    items: [
      {
        id: "pm-5",
        title: "Fix multiline\nrelease title",
        status: "closed",
        type: "bug",
        url: "https://user@example.com/unbraind/pm-changelog/issues/5",
        updated_at: "2026-05-17T10:00:00Z",
      },
    ],
    version: "1.2.0",
    date: "2026-05-17",
    includeLinks: true,
  });

  assert.match(linked.markdown, /- Fix multiline release title \(pm-5\) \[link\]\(https:\/\/example\.com\/unbraind\/pm-changelog\/issues\/5\)/);
  assert.doesNotMatch(linked.markdown, /user|token|secret/);
});

test("createChangelog strips query and hash data from item links", () => {
  const result = createChangelog({
    items: [
      {
        id: "pm-6",
        title: "Add runner changelog output",
        status: "closed",
        type: "feature",
        url: "https://example.com/issues/6?token=secret#private-note",
        updated_at: "2026-05-17T10:00:00Z",
      },
    ],
    version: "1.2.0",
    date: "2026-05-17",
    includeLinks: true,
  });

  assert.match(result.markdown, /\[link\]\(https:\/\/example\.com\/issues\/6\)/);
  assert.doesNotMatch(result.markdown, /token|secret|private-note/);
});

test("createChangelog makes item IDs clickable links when itemUrlBase is set", () => {
  const base = "https://github.com/example/repo/blob/main/.agents/pm";

  const issueResult = createChangelog({
    items: [
      {
        id: "pmc-abc",
        title: "Fix something important",
        status: "closed",
        type: "Issue",
        updated_at: "2026-05-17T10:00:00Z",
      },
    ],
    version: "1.2.0",
    date: "2026-05-17",
    itemUrlBase: base,
  });

  assert.match(
    issueResult.markdown,
    /- Fix something important \(\[pmc-abc\]\(https:\/\/github\.com\/example\/repo\/blob\/main\/\.agents\/pm\/issues\/pmc-abc\.toon\)\)/
  );

  const choreResult = createChangelog({
    items: [
      {
        id: "pmc-def",
        title: "Update dependencies",
        status: "closed",
        type: "Chore",
        updated_at: "2026-05-17T10:00:00Z",
      },
    ],
    version: "1.2.0",
    date: "2026-05-17",
    itemUrlBase: base,
  });

  assert.match(
    choreResult.markdown,
    /\[pmc-def\]\(https:\/\/github\.com\/example\/repo\/blob\/main\/\.agents\/pm\/chores\/pmc-def\.toon\)/
  );

  const taskResult = createChangelog({
    items: [
      {
        id: "pmc-ghi",
        title: "Set up CI",
        status: "closed",
        type: "Task",
        updated_at: "2026-05-17T10:00:00Z",
      },
    ],
    version: "1.2.0",
    date: "2026-05-17",
    itemUrlBase: `${base}/`,
  });

  assert.match(
    taskResult.markdown,
    /\[pmc-ghi\]\(https:\/\/github\.com\/example\/repo\/blob\/main\/\.agents\/pm\/tasks\/pmc-ghi\.toon\)/
  );
  assert.doesNotMatch(taskResult.markdown, /pm\/\/tasks/);
});

const REF_STYLE_ITEM = {
  id: "pmc-abc",
  title: "Fix something important",
  status: "closed",
  type: "Issue",
  updated_at: "2026-05-17T10:00:00Z",
} as const;
const REF_STYLE_BASE = "https://github.com/example/repo/blob/main/.agents/pm";

test("itemRefStyle 'label' renders a neutral label even when itemUrlBase is set (public-doc safe)", () => {
  const result = createChangelog({
    items: [{ ...REF_STYLE_ITEM }],
    version: "1.2.0",
    date: "2026-05-17",
    itemUrlBase: REF_STYLE_BASE,
    itemRefStyle: "label",
  });
  assert.match(result.markdown, /- Fix something important \(pmc-abc\)/);
  assert.doesNotMatch(result.markdown, /\.agents\/pm/);
  assert.doesNotMatch(result.markdown, /\]\(http/);
});

test("itemRefStyle 'toon' forces the blob link, and falls back to a label when itemUrlBase is unset", () => {
  const linked = createChangelog({
    items: [{ ...REF_STYLE_ITEM }],
    version: "1.2.0",
    date: "2026-05-17",
    itemUrlBase: REF_STYLE_BASE,
    itemRefStyle: "toon",
  });
  assert.match(
    linked.markdown,
    /\(\[pmc-abc\]\(https:\/\/github\.com\/example\/repo\/blob\/main\/\.agents\/pm\/issues\/pmc-abc\.toon\)\)/
  );

  const unset = createChangelog({
    items: [{ ...REF_STYLE_ITEM }],
    version: "1.2.0",
    date: "2026-05-17",
    itemRefStyle: "toon",
  });
  assert.match(unset.markdown, /\(pmc-abc\)/);
  assert.doesNotMatch(unset.markdown, /\]\(http/);
});

test("itemRefStyle 'github' renders a public issue link from the gh: provenance tag", () => {
  const result = createChangelog({
    items: [
      {
        ...REF_STYLE_ITEM,
        tags: ["area:search", "gh:unbraind/pm-changelog#467"],
      },
    ],
    version: "1.2.0",
    date: "2026-05-17",
    // itemUrlBase is deliberately set to prove github mode ignores the blob base.
    itemUrlBase: REF_STYLE_BASE,
    itemRefStyle: "github",
  });
  assert.match(
    result.markdown,
    /- Fix something important \(\[#467\]\(https:\/\/github\.com\/unbraind\/pm-changelog\/issues\/467\)\)/
  );
  assert.doesNotMatch(result.markdown, /\.agents\/pm/);
});

test("itemRefStyle 'github' falls back to a neutral label without a valid provenance tag", () => {
  const noTag = createChangelog({
    items: [{ ...REF_STYLE_ITEM, tags: ["area:search"] }],
    version: "1.2.0",
    date: "2026-05-17",
    itemRefStyle: "github",
  });
  assert.match(noTag.markdown, /- Fix something important \(pmc-abc\)/);
  assert.doesNotMatch(noTag.markdown, /\]\(http/);

  // Malformed provenance tags must not produce a link either.
  for (const badTag of ["gh:onlyrepo#5", "gh:owner/repo#notanumber", "gh:owner/repo#0", "gh:owner/repo#-3", "gh:owner/repo/extra#5"]) {
    const bad = createChangelog({
      items: [{ ...REF_STYLE_ITEM, tags: [badTag] }],
      version: "1.2.0",
      date: "2026-05-17",
      itemRefStyle: "github",
    });
    assert.match(bad.markdown, /\(pmc-abc\)/, `expected label fallback for tag ${badTag}`);
    assert.doesNotMatch(bad.markdown, /\]\(http/, `expected no link for tag ${badTag}`);
  }
});

test("itemRefStyle 'auto' (default) reproduces historical behavior", () => {
  // With itemUrlBase → blob link (same as omitting itemRefStyle entirely).
  const withBase = createChangelog({
    items: [{ ...REF_STYLE_ITEM }],
    version: "1.2.0",
    date: "2026-05-17",
    itemUrlBase: REF_STYLE_BASE,
    itemRefStyle: "auto",
  });
  const defaulted = createChangelog({
    items: [{ ...REF_STYLE_ITEM }],
    version: "1.2.0",
    date: "2026-05-17",
    itemUrlBase: REF_STYLE_BASE,
  });
  assert.equal(withBase.markdown, defaulted.markdown);
  assert.match(withBase.markdown, /\[pmc-abc\]\(https:\/\/github\.com\/example\/repo\/blob\/main\/\.agents\/pm\/issues\/pmc-abc\.toon\)/);

  // Without itemUrlBase → neutral label.
  const noBase = createChangelog({
    items: [{ ...REF_STYLE_ITEM }],
    version: "1.2.0",
    date: "2026-05-17",
    itemRefStyle: "auto",
  });
  assert.match(noBase.markdown, /\(pmc-abc\)/);
  assert.doesNotMatch(noBase.markdown, /\]\(http/);
});

test("mergeChangelog creates a missing changelog", () => {
  const generated = createChangelog({
    items,
    version: "1.2.0",
    date: "2026-05-17",
  });

  const result = mergeChangelog(undefined, generated.markdown);

  assert.equal(result.action, "created");
  assert.equal(result.changed, true);
  assert.equal(result.markdown, generated.markdown);
});

test("mergeChangelog prepends a new release and preserves older releases", () => {
  const existing = `# Changelog

## 1.1.0 - 2026-05-01

### Fixed

- Existing fix
`;
  const generated = createChangelog({
    items,
    version: "1.2.0",
    date: "2026-05-17",
  });

  const result = mergeChangelog(existing, generated.markdown);

  assert.equal(result.action, "inserted");
  assert.match(result.markdown, /## 1\.2\.0 - 2026-05-17[\s\S]*## 1\.1\.0 - 2026-05-01/);
  assert.match(result.markdown, /- Existing fix/);
});

test("mergeChangelog replaces an existing generated release", () => {
  const existing = `# Changelog

## 1.2.0 - 2026-05-17

### Fixed

- Old line

## 1.1.0 - 2026-05-01

### Fixed

- Existing fix
`;
  const generated = createChangelog({
    items,
    version: "1.2.0",
    date: "2026-05-17",
  });

  const result = mergeChangelog(existing, generated.markdown);

  assert.equal(result.action, "replaced");
  assert.doesNotMatch(result.markdown, /Old line/);
  assert.match(result.markdown, /## 1\.2\.0 - 2026-05-17[\s\S]*## 1\.1\.0 - 2026-05-01/);
});

test("mergeChangelog promotes a leading Unreleased section into the generated release (no duplicate)", () => {
  const existing = `# Changelog

## Unreleased - 2026-05-13

### Fixed

- Existing fix
- Existing fix two

## 1.1.0 - 2026-05-01

### Fixed

- Older release fix
`;
  const generated = createChangelog({
    items,
    version: "1.2.0",
    date: "2026-05-17",
  });

  const result = mergeChangelog(existing, generated.markdown);

  assert.equal(result.action, "replaced");
  // The stale Unreleased section is gone — promoted into the version it ships in.
  assert.doesNotMatch(result.markdown, /## Unreleased/);
  assert.equal((result.markdown.match(/## 1\.2\.0 - 2026-05-17/g) ?? []).length, 1);
  // Promoted in place at the top, ahead of the preserved older release.
  assert.match(result.markdown, /## 1\.2\.0 - 2026-05-17[\s\S]*## 1\.1\.0 - 2026-05-01/);
  assert.match(result.markdown, /- Older release fix/);
});

test("mergeChangelog keeps a generated Unreleased section instead of promoting it", () => {
  const existing = `# Changelog

## Unreleased - 2026-05-10

### Fixed

- Stale pending entry

## 1.1.0 - 2026-05-01

### Fixed

- Older release fix
`;
  const generated = createChangelog({
    items,
    date: "2026-05-17",
  });

  const result = mergeChangelog(existing, generated.markdown);

  // Generator emitted an Unreleased section, so it replaces (not promotes).
  assert.equal(result.action, "replaced");
  assert.match(result.markdown, /## Unreleased/);
  assert.doesNotMatch(result.markdown, /Stale pending entry/);
  assert.match(result.markdown, /## 1\.1\.0 - 2026-05-01/);

  // The merged Unreleased section is exactly the generator's Unreleased section.
  const sliceUnreleased = (md: string): string | undefined =>
    md.match(/## Unreleased[\s\S]*?(?=\n## |\s*$)/)?.[0];
  const generatedUnreleased = sliceUnreleased(generated.markdown);
  assert.ok(generatedUnreleased, "generated changelog should contain an Unreleased section");
  assert.equal(sliceUnreleased(result.markdown)?.trimEnd(), generatedUnreleased.trimEnd());
});

test("mergeChangelog does not let an older generated section consume the pending Unreleased", () => {
  // Newest generated version already exists (replaced); a missing older version
  // must NOT promote the pending Unreleased into itself (GH #48 review).
  const existing = `# Changelog

## Unreleased - 2026-05-20

### Fixed

- Pending entry not yet released

## 1.2.0 - 2026-05-17

### Fixed

- Shipped fix
`;
  const generated = `# Changelog

## 1.2.0 - 2026-05-17

### Fixed

- Shipped fix (updated)

## 1.1.0 - 2026-05-01

### Added

- Backfilled older release
`;

  const result = mergeChangelog(existing, generated);

  assert.equal(result.action, "replaced");
  // The pending Unreleased survives untouched at the top.
  assert.match(result.markdown, /## Unreleased - 2026-05-20[\s\S]*Pending entry not yet released/);
  assert.match(result.markdown, /- Pending entry not yet released/);
  // The older version is inserted as its own section, not by stealing Unreleased.
  assert.match(result.markdown, /## 1\.1\.0 - 2026-05-01[\s\S]*Backfilled older release/);
  // Exactly one Unreleased section remains.
  assert.equal((result.markdown.match(/## Unreleased/g) ?? []).length, 1);
  // Sections stay in chronological order (newest to oldest); the backfilled
  // older release is not hoisted above newer sections or Unreleased.
  assert.match(
    result.markdown,
    /## Unreleased - 2026-05-20[\s\S]*## 1\.2\.0 - 2026-05-17[\s\S]*## 1\.1\.0 - 2026-05-01/
  );
});

test("mergeChangelog promotes a bracketed Keep a Changelog Unreleased heading", () => {
  const existing = `# Changelog

## [Unreleased]

### Fixed

- Pending fix

## 1.1.0 - 2026-05-01

### Fixed

- Older release fix
`;
  const generated = createChangelog({
    items,
    version: "1.2.0",
    date: "2026-05-17",
  });

  const result = mergeChangelog(existing, generated.markdown);

  assert.equal(result.action, "replaced");
  assert.doesNotMatch(result.markdown, /Unreleased/);
  assert.equal((result.markdown.match(/## 1\.2\.0 - 2026-05-17/g) ?? []).length, 1);
  assert.match(result.markdown, /## 1\.2\.0 - 2026-05-17[\s\S]*## 1\.1\.0 - 2026-05-01/);
});

test("mergeChangelog replaces Keep a Changelog bracketed release headings", () => {
  const existing = `# Changelog

All notable changes to this project are documented in this file.

## [1.2.0] - 2026-05-17

### Fixed

- Old generated line

## [1.1.0] - 2026-05-01

### Fixed

- Existing historical fix
`;
  const generated = createChangelog({
    items,
    version: "1.2.0",
    date: "2026-05-17",
  });

  const result = mergeChangelog(existing, generated.markdown);

  assert.equal(result.action, "replaced");
  assert.doesNotMatch(result.markdown, /Old generated line/);
  assert.match(result.markdown, /All notable changes to this project are documented/);
  assert.match(result.markdown, /## 1\.2\.0 - 2026-05-17[\s\S]*## \[1\.1\.0\] - 2026-05-01/);
  assert.match(result.markdown, /- Existing historical fix/);
});

test("writeChangelog writes and reports unchanged check runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const output = join(dir, "CHANGELOG.md");

  const written = writeChangelog({
    items,
    output,
    version: "1.2.0",
    date: "2026-05-17",
  });

  assert.equal(written.action, "created");
  assert.equal(written.changed, true);
  assert.equal(readFileSync(output, "utf-8"), written.markdown);

  const checked = writeChangelog({
    items,
    output,
    version: "1.2.0",
    date: "2026-05-17",
    check: true,
  });

  assert.equal(checked.action, "unchanged");
  assert.equal(checked.changed, false);
  assert.equal(readFileSync(output, "utf-8"), written.markdown);
});

test("writeChangelog check mode does not overwrite stale files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const output = join(dir, "CHANGELOG.md");
  writeFileSync(output, "# Changelog\n\nOld content\n", "utf-8");

  const result = writeChangelog({
    items,
    output,
    version: "1.2.0",
    date: "2026-05-17",
    check: true,
  });

  assert.equal(result.action, "replaced");
  assert.equal(result.changed, true);
  assert.equal(readFileSync(output, "utf-8"), "# Changelog\n\nOld content\n");
});

test("CLI writes GitHub Actions outputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const input = join(dir, "items.json");
  const output = join(dir, "CHANGELOG.md");
  const githubOutput = join(dir, "github-output.txt");
  writeFileSync(input, JSON.stringify(items), "utf-8");

  const stdout = execFileSync(
    process.execPath,
    [
      "src/cli.ts",
      "--input",
      input,
      "--output",
      output,
      "--version",
      "1.2.0",
      "--date",
      "2026-05-17",
      "--json",
      "--github-output",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, GITHUB_OUTPUT: githubOutput },
      encoding: "utf-8",
    }
  );

  const summary = JSON.parse(stdout);
  assert.equal(summary.changed, true);
  assert.equal(summary.itemCount, 2);
  assert.match(readFileSync(githubOutput, "utf-8"), /changed=true/);
  assert.match(readFileSync(output, "utf-8"), /## 1\.2\.0 - 2026-05-17/);
});

test("CLI can append generated markdown to GitHub step summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const input = join(dir, "items.json");
  const output = join(dir, "CHANGELOG.md");
  const stepSummary = join(dir, "step-summary.md");
  writeFileSync(input, JSON.stringify(items), "utf-8");

  execFileSync(
    process.execPath,
    [
      "src/cli.ts",
      "--input",
      input,
      "--output",
      output,
      "--version",
      "1.2.0",
      "--date",
      "2026-05-17",
      "--github-step-summary",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, GITHUB_STEP_SUMMARY: stepSummary },
      encoding: "utf-8",
    }
  );

  const summary = readFileSync(stepSummary, "utf-8");
  assert.match(summary, /^# Changelog\n\n## 1\.2\.0 - 2026-05-17/m);
  assert.match(summary, /- Add GitHub Actions changelog command \(pm-1\)/);
});

test("CLI stdout JSON includes markdown for runners without writing output", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const input = join(dir, "items.json");
  const output = join(dir, "CHANGELOG.md");
  writeFileSync(input, JSON.stringify(items), "utf-8");

  const stdout = execFileSync(
    process.execPath,
    [
      "src/cli.ts",
      "--input",
      input,
      "--output",
      output,
      "--stdout",
      "--json",
      "--version",
      "1.2.0",
      "--date",
      "2026-05-17",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
    }
  );

  const summary = JSON.parse(stdout);
  assert.equal(summary.changed, true);
  assert.equal(summary.itemCount, 2);
  assert.match(summary.markdown, /## 1\.2\.0 - 2026-05-17/);
  assert.throws(() => readFileSync(output, "utf-8"));
});

test("CLI can derive package release version and git tag range", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-release-context-"));
  const input = join(dir, "items.json");
  const cli = join(process.cwd(), "src", "cli.ts");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.0" }), "utf-8");
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(join(dir, "file.txt"), "one\n", "utf-8");
  execFileSync("git", ["add", "."], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "one"], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-05-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-05-01T00:00:00Z",
    },
    encoding: "utf-8",
  });
  execFileSync("git", ["tag", "v1.1.0"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(join(dir, "file.txt"), "two\n", "utf-8");
  execFileSync("git", ["commit", "-am", "two"], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-05-10T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-05-10T00:00:00Z",
    },
    encoding: "utf-8",
  });
  execFileSync("git", ["tag", "v1.2.0"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(
    input,
    JSON.stringify([
      {
        id: "pm-old",
        title: "Old release item",
        status: "closed",
        type: "bug",
        closed_at: "2026-04-20T00:00:00Z",
      },
      {
        id: "pm-new",
        title: "Current release item",
        status: "closed",
        type: "feature",
        closed_at: "2026-05-05T00:00:00Z",
      },
      {
        id: "pm-next",
        title: "Post-release item",
        status: "closed",
        type: "task",
        closed_at: "2026-05-12T00:00:00Z",
      },
    ]),
    "utf-8"
  );

  const stdout = execFileSync(
    process.execPath,
    [
      cli,
      "--input",
      input,
      "--stdout",
      "--release-version-from-package",
      "--since-previous-tag",
      "--until-release-tag",
    ],
    {
      cwd: dir,
      encoding: "utf-8",
    }
  );

  assert.match(stdout, /## 1\.2\.0 - 2026-05-10/);
  assert.match(stdout, /Current release item/);
  assert.doesNotMatch(stdout, /Old release item|Post-release item|## Unreleased/);
});

test("CLI derives release heading date from existing package tag without limiting the window", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-release-date-"));
  const input = join(dir, "items.json");
  const cli = join(process.cwd(), "src", "cli.ts");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.3.0" }), "utf-8");
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(join(dir, "file.txt"), "one\n", "utf-8");
  execFileSync("git", ["add", "."], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "one"], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-05-03T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-05-03 14:00:00 +0000",
    },
    encoding: "utf-8",
  });
  execFileSync("git", ["tag", "v1.2.0"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(join(dir, "file.txt"), "two\n", "utf-8");
  execFileSync("git", ["commit", "-am", "two"], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-05-11T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-05-11 14:00:00 +0000",
    },
    encoding: "utf-8",
  });
  execFileSync("git", ["tag", "v1.3.0"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(
    input,
    JSON.stringify([
      {
        id: "pm-current",
        title: "Current package item",
        status: "closed",
        type: "feature",
        closed_at: "2026-05-10T00:00:00Z",
      },
      {
        id: "pm-after",
        title: "Post tag tracker closure",
        status: "closed",
        type: "task",
        closed_at: "2026-05-12T00:00:00Z",
      },
    ]),
    "utf-8"
  );

  const stdout = execFileSync(
    process.execPath,
    [cli, "--input", input, "--stdout", "--release-version-from-package", "--since-previous-tag"],
    {
      cwd: dir,
      encoding: "utf-8",
    }
  );

  assert.match(stdout, /## 1\.3\.0 - 2026-05-11/);
  assert.match(stdout, /Current package item/);
  assert.match(stdout, /Post tag tracker closure/);
});

// --- Missing git tag history diagnostics (pmc-yzho) ---------------------------
// Tag-derived flags (`--since-previous-tag`, `--until-release-tag`,
// `--all-release-tags`) must fail fast with a structured E_MISSING_TAG_HISTORY
// diagnostic in shallow clones instead of silently deriving an incomplete
// window and misreporting a correct CHANGELOG.md as stale. Full clones keep
// byte-identical behavior, including the intentional zero-tag first-release
// fallbacks.

function createTagHistorySourceRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.0" }), "utf-8");
  writeFileSync(join(dir, "file.txt"), "one\n", "utf-8");
  execFileSync("git", ["add", "."], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "one"], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-05-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-05-01T00:00:00Z" },
    encoding: "utf-8",
  });
  execFileSync("git", ["tag", "v1.1.0"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(join(dir, "file.txt"), "two\n", "utf-8");
  execFileSync("git", ["commit", "-am", "two"], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-05-10T00:00:00Z", GIT_COMMITTER_DATE: "2026-05-10T00:00:00Z" },
    encoding: "utf-8",
  });
  execFileSync("git", ["tag", "v1.2.0"], { cwd: dir, encoding: "utf-8" });
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function createShallowClone(t: test.TestContext, cloneArgs: string[]): { sourceDir: string; cloneDir: string } {
  const sourceDir = mkdtempSync(join(tmpdir(), "pm-changelog-shallow-src-"));
  const cloneParent = mkdtempSync(join(tmpdir(), "pm-changelog-shallow-dst-"));
  t.after(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(cloneParent, { recursive: true, force: true });
  });
  createTagHistorySourceRepo(sourceDir);
  const cloneDir = join(cloneParent, "clone");
  // A file:// URL forces the transport path so --depth/--no-tags are honored
  // (plain local paths are hardlinked and ignore shallow flags).
  execFileSync("git", ["clone", "--depth", "1", ...cloneArgs, pathToFileURL(sourceDir).toString(), cloneDir], { encoding: "utf-8" });
  return { sourceDir, cloneDir };
}

test("resolveReleaseContext rejects tag-derived flags in a shallow tagless clone", (t) => {
  const { cloneDir } = createShallowClone(t, ["--no-tags"]);

  assert.equal(gitOutput(cloneDir, ["rev-parse", "--is-shallow-repository"]), "true");
  assert.equal(gitOutput(cloneDir, ["tag", "--list"]), "");

  assert.throws(
    () => resolveReleaseContext({ cwd: cloneDir, version: "1.2.0", sincePreviousTag: true, untilReleaseTag: true }),
    (error: unknown) => {
      assert.ok(error instanceof MissingTagHistoryError);
      assert.equal(error.code, MISSING_TAG_HISTORY_ERROR_CODE);
      assert.match(error.message, /E_MISSING_TAG_HISTORY/);
      assert.match(error.message, /--since-previous-tag/);
      assert.match(error.message, /--until-release-tag/);
      assert.match(error.message, /shallow clone/);
      assert.match(error.message, /git fetch --tags --unshallow/);
      assert.match(error.message, /git fetch --tags/);
      // This clone was made with --no-tags, so the recovery must also unset
      // the tag-excluding config or the next run trips the tagOpt diagnostic.
      assert.deepEqual(
        [...error.recoveryCommands],
        ["git config --unset remote.origin.tagOpt", "git fetch --tags --unshallow"],
      );
      return true;
    }
  );
});

test("resolveReleaseContext rejects tag-derived flags in a shallow clone that kept a tip tag", (t) => {
  const { cloneDir } = createShallowClone(t, []);

  // The depth-1 clone keeps the tag pointing at its tip commit, but the older
  // tag history the previous-tag window needs is truncated away, so resolving
  // a window must still fail fast instead of silently degrading.
  assert.equal(gitOutput(cloneDir, ["rev-parse", "--is-shallow-repository"]), "true");
  assert.equal(gitOutput(cloneDir, ["tag", "--list"]), "v1.2.0");

  assert.throws(
    () => resolveReleaseContext({ cwd: cloneDir, version: "1.2.0", sincePreviousTag: true }),
    (error: unknown) => {
      assert.ok(error instanceof MissingTagHistoryError);
      assert.match(error.message, /E_MISSING_TAG_HISTORY/);
      assert.match(error.message, /--since-previous-tag/);
      return true;
    }
  );
});

test("resolveReleaseContext rejects tag-derived flags in a FULL clone made with --no-tags", (t) => {
  const sourceDir = mkdtempSync(join(tmpdir(), "pm-changelog-notags-src-"));
  const cloneParent = mkdtempSync(join(tmpdir(), "pm-changelog-notags-dst-"));
  t.after(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(cloneParent, { recursive: true, force: true });
  });
  createTagHistorySourceRepo(sourceDir);
  const cloneDir = join(cloneParent, "clone");
  // Full-depth clone that deliberately excludes tags: not shallow, zero tags,
  // but remote.origin.tagOpt records the exclusion.
  execFileSync("git", ["clone", "--no-tags", pathToFileURL(sourceDir).toString(), cloneDir], { encoding: "utf-8" });
  assert.equal(gitOutput(cloneDir, ["rev-parse", "--is-shallow-repository"]), "false");
  assert.equal(gitOutput(cloneDir, ["tag", "--list"]), "");

  assert.throws(
    () => resolveReleaseContext({ cwd: cloneDir, version: "1.2.0", sincePreviousTag: true }),
    (error: unknown) => {
      assert.ok(error instanceof MissingTagHistoryError);
      assert.equal(error.code, MISSING_TAG_HISTORY_ERROR_CODE);
      assert.match(error.message, /--no-tags/);
      assert.match(error.message, /git config --unset remote\.origin\.tagOpt && git fetch --tags/);
      assert.deepEqual([...error.recoveryCommands], ["git config --unset remote.origin.tagOpt", "git fetch --tags"]);
      return true;
    }
  );

  // A single explicitly fetched tag does NOT unblock the guard: the tag set
  // of a --no-tags clone is still untrustworthy (findPreviousTag would see no
  // prior tag and silently derive an unbounded window).
  execFileSync("git", ["fetch", "origin", "tag", "v1.2.0"], { cwd: cloneDir, encoding: "utf-8" });
  assert.equal(gitOutput(cloneDir, ["tag", "--list"]), "v1.2.0");
  assert.throws(
    () => resolveReleaseContext({ cwd: cloneDir, version: "1.2.0", sincePreviousTag: true }),
    (error: unknown) => {
      assert.ok(error instanceof MissingTagHistoryError);
      assert.match(error.message, /--no-tags/);
      return true;
    }
  );

  // The named recovery command actually converges: after it runs, the same
  // call succeeds with the full window.
  execFileSync("git", ["config", "--unset", "remote.origin.tagOpt"], { cwd: cloneDir, encoding: "utf-8" });
  execFileSync("git", ["fetch", "--tags"], { cwd: cloneDir, encoding: "utf-8" });
  const recovered = resolveReleaseContext({ cwd: cloneDir, version: "1.2.0", sincePreviousTag: true });
  assert.equal(recovered.previousTag, "v1.1.0");
});

test("resolveReleaseContext keeps full-clone and zero-tag first-release behavior", (t) => {
  const { sourceDir } = createShallowClone(t, ["--no-tags"]);

  // Full clone with tags: the guard is a no-op and windows resolve as before.
  assert.equal(gitOutput(sourceDir, ["rev-parse", "--is-shallow-repository"]), "false");
  const context = resolveReleaseContext({ cwd: sourceDir, version: "1.2.0", sincePreviousTag: true, untilReleaseTag: true });
  assert.equal(context.releaseTag, "v1.2.0");
  assert.equal(context.previousTag, "v1.1.0");
  // Compare instants, not textual offsets: %cI offset formatting varies by git version.
  assert.equal(Date.parse(context.since!), Date.parse("2026-05-01T00:00:00Z"));
  assert.equal(Date.parse(context.until!), Date.parse("2026-05-10T00:00:00Z"));
  assert.equal(
    resolveReleaseContext({ cwd: sourceDir, version: "1.2.0", dateFromVersion: true }).date,
    context.date,
    "an existing tag must prevent the inapplicable CalVer fallback from being parsed",
  );

  // Full clone genuinely without any release tags yet (first-release flow):
  // the intentional silent fallback to an unbounded window is preserved.
  const firstDir = mkdtempSync(join(tmpdir(), "pm-changelog-first-release-"));
  t.after(() => rmSync(firstDir, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: firstDir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: firstDir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: firstDir, encoding: "utf-8" });
  writeFileSync(join(firstDir, "file.txt"), "one\n", "utf-8");
  execFileSync("git", ["add", "."], { cwd: firstDir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "one"], { cwd: firstDir, encoding: "utf-8" });

  const first = resolveReleaseContext({ cwd: firstDir, version: "1.0.0", sincePreviousTag: true, untilReleaseTag: true });
  assert.equal(first.releaseTag, undefined);
  assert.equal(first.previousTag, undefined);
  assert.equal(first.since, undefined);
  assert.equal(first.until, undefined);

  // A release-gated repository has no tag by design. Its fallback must be
  // stable before the first release instead of inheriting the wall clock.
  assert.equal(
    resolveReleaseContext({ cwd: firstDir, version: "1.0.0", dateFallback: "2026-08-08" }).date,
    "2026-08-08",
  );
  assert.equal(
    resolveReleaseContext({ cwd: firstDir, version: "2026.8.8", dateFromVersion: true }).date,
    "2026-08-08",
  );

  // Once the release is tagged, the commit timestamp is authoritative and the
  // old fallback disarms itself without a follow-up edit.
  writeFileSync(join(firstDir, "file.txt"), "two\n", "utf-8");
  execFileSync("git", ["commit", "-am", "release"], {
    cwd: firstDir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-12T23:30:00+02:00",
      GIT_COMMITTER_DATE: "2026-08-12T23:30:00+02:00",
    },
    encoding: "utf-8",
  });
  execFileSync("git", ["tag", "v2026.8.8"], {
    cwd: firstDir,
    encoding: "utf-8",
  });
  assert.equal(
    resolveReleaseContext({ cwd: firstDir, version: "2026.8.8", dateFallback: "2026-01-01" }).date,
    "2026-08-12",
  );
  assert.equal(
    resolveReleaseContext({ cwd: firstDir, version: "2026.8.8", dateFromVersion: true }).date,
    "2026-08-12",
  );
});

test("resolveReleaseContext derives the date from a same-day release suffix", () => {
  // The release workflow tags a second release on one day as v2026.8.24-2, so
  // refusing the suffix would make the generator fail hard on exactly the day a
  // package released twice -- turning a stale heading date into a broken
  // release. The suffix distinguishes releases, not days, so the date is the
  // calendar day and the suffix survives in the version itself.
  assert.equal(
    resolveReleaseContext({ version: "2026.8.24-2", dateFromVersion: true }).date,
    "2026-08-24",
  );
  assert.equal(
    resolveReleaseContext({ version: "v2026.8.24-11", dateFromVersion: true }).date,
    "2026-08-24",
  );
  // A non-numeric suffix is still refused: it is a prerelease spelling, not a
  // same-day counter, and guessing a date for it would invent one.
  assert.throws(
    () => resolveReleaseContext({ version: "2026.8.24-beta.1", dateFromVersion: true }),
    /--date-from-version requires a calendar version/,
  );
  // The suffix must not rescue an impossible calendar date.
  assert.throws(
    () => resolveReleaseContext({ version: "2026.2.30-2", dateFromVersion: true }),
    /--date-from-version requires a calendar version/,
  );
});

test("resolveReleaseContext validates version-derived fallback dates", () => {
  for (const version of [undefined, "1.2.3", "2026.13.1", "2026.2.30", "2026.8.8-beta.1"]) {
    assert.throws(
      () => resolveReleaseContext({ version, dateFromVersion: true }),
      /--date-from-version requires a calendar version in YYYY\.M\.D form/,
    );
  }
  assert.throws(
    () => resolveReleaseContext({ version: "2026.8.8", dateFallback: "2026-08-08", dateFromVersion: true }),
    /--date-fallback and --date-from-version are mutually exclusive/,
  );
});

test("CLI exposes stable no-tag fallback dates without weakening explicit date precedence", () => {
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-date-fallback-cli-"));
  const input = join(directory, "items.json");
  writeFileSync(input, JSON.stringify(items), "utf-8");
  const cli = join(process.cwd(), "src", "cli.ts");

  const derived = execFileSync(process.execPath, [
    cli,
    "--input", input,
    "--stdout",
    "--version", "2026.8.8",
    "--date-from-version",
  ], { cwd: directory, encoding: "utf-8" });
  assert.match(derived, /## 2026\.8\.8 - 2026-08-08/);

  const explicit = execFileSync(process.execPath, [
    cli,
    "--input", input,
    "--stdout",
    "--version", "2026.8.8",
    "--date", "2026-09-01",
    "--date-fallback", "2026-08-08",
  ], { cwd: directory, encoding: "utf-8" });
  assert.match(explicit, /## 2026\.8\.8 - 2026-09-01/);

  const conflicting = spawnSync(process.execPath, [
    cli,
    "--input", input,
    "--stdout",
    "--version", "2026.8.8",
    "--date-fallback", "2026-08-08",
    "--date-from-version",
  ], { cwd: directory, encoding: "utf-8" });
  assert.equal(conflicting.status, 1);
  assert.match(conflicting.stderr, /mutually exclusive/);
});

test("pending all-release-tags output is byte-identical after tagging the release commit", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-pending-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "pm changelog test"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "pm-changelog@example.com"], { cwd: directory, encoding: "utf-8" });
  writeFileSync(join(directory, "release.txt"), "release\n", "utf-8");
  execFileSync("git", ["add", "release.txt"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "release"], {
    cwd: directory,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-30T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-30T12:00:00Z",
    },
  });

  const input = join(directory, "items.json");
  writeFileSync(input, JSON.stringify([{
    id: "pm-release-day",
    title: "Keep release-day work in the pending release",
    status: "closed",
    type: "bug",
    closed_at: "2026-08-30T09:00:00Z",
  }]), "utf-8");
  const cli = join(process.cwd(), "src", "cli.ts");
  const command = [
    cli,
    "--input", input,
    "--stdout",
    "--all-release-tags",
    "--version", "2026.8.30",
    "--date-from-version",
  ];
  const generate = (): string => execFileSync(process.execPath, command, {
    cwd: directory,
    encoding: "utf-8",
    env: { ...process.env, TZ: "UTC" },
  });

  const beforeTag = generate();
  assert.match(beforeTag, /## 2026\.8\.30 - 2026-08-30[\s\S]*pm-release-day/);
  assert.doesNotMatch(beforeTag, /## Unreleased/);

  execFileSync("git", ["tag", "v2026.8.30"], { cwd: directory, encoding: "utf-8" });
  const afterTag = generate();
  assert.equal(afterTag, beforeTag);
});

test("--no-pending-release keeps a never-released package version out of the headings", (t) => {
  // The pm-vcs/pm-rl regression shape (unbraind/pm-vcs run 33379641902): zero
  // release tags, a package.json version that has never been released or
  // tagged. Since 2026.8.30 (PR #170) the untagged version is treated as a
  // pending release, so `--all-release-tags --release-version-from-package`
  // rewrites the leading `## Unreleased` into `## 2026.7.30 - 2026-07-30` — a
  // heading asserting a release that never happened. `--no-pending-release`
  // says no release is being cut and restores the Unreleased window.
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-never-released-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "pm changelog test"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "pm-changelog@example.com"], { cwd: directory, encoding: "utf-8" });
  writeFileSync(join(directory, "work.txt"), "work\n", "utf-8");
  execFileSync("git", ["add", "work.txt"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "work"], {
    cwd: directory,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-07-30T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-07-30T12:00:00Z",
    },
  });
  // Placeholder version that has never been released: no tag exists for it.
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "pm-vcs-fixture", version: "2026.7.30" }),
    "utf-8",
  );

  const input = join(directory, "items.json");
  writeFileSync(input, JSON.stringify([{
    id: "pm-never-released",
    title: "Keep never-released work under Unreleased",
    status: "closed",
    type: "feature",
    closed_at: "2026-08-15T09:00:00Z",
  }]), "utf-8");
  const cli = join(process.cwd(), "src", "cli.ts");
  const generate = (extra: string[]): string => execFileSync(process.execPath, [
    cli,
    "--input", input,
    "--stdout",
    "--all-release-tags",
    "--release-version-from-package",
    "--date-from-version",
    ...extra,
  ], {
    cwd: directory,
    encoding: "utf-8",
    env: { ...process.env, TZ: "UTC" },
  });

  // Default behaviour is unchanged: the pending window still leads (the
  // release-run shape PR #170 established), which fabricates the heading in
  // this never-released shape.
  const fabricated = generate([]);
  assert.match(fabricated, /## 2026\.7\.30 - 2026-07-30[\s\S]*pm-never-released/);
  assert.doesNotMatch(fabricated, /## Unreleased/);

  // The flag suppresses the fabricated window and restores Unreleased.
  const suppressed = generate(["--no-pending-release"]);
  assert.match(suppressed, /## Unreleased[\s\S]*pm-never-released/);
  assert.doesNotMatch(suppressed, /2026\.7\.30/);
});

test("resolveReleaseTagWindows rejects shallow clones but preserves zero-tag pending windows", (t) => {
  const { cloneDir } = createShallowClone(t, []);

  assert.throws(
    () => resolveReleaseTagWindows({ cwd: cloneDir, includeOrphaned: true }),
    (error: unknown) => {
      assert.ok(error instanceof MissingTagHistoryError);
      assert.match(error.message, /E_MISSING_TAG_HISTORY/);
      assert.match(error.message, /--all-release-tags/);
      assert.match(error.message, /git fetch --tags --unshallow/);
      return true;
    }
  );

  // A full clone with zero tags keeps the pending-version first-release
  // windows (Unreleased + pending) that the release pipeline relies on.
  const firstDir = mkdtempSync(join(tmpdir(), "pm-changelog-pending-first-"));
  t.after(() => rmSync(firstDir, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: firstDir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: firstDir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: firstDir, encoding: "utf-8" });
  writeFileSync(join(firstDir, "file.txt"), "one\n", "utf-8");
  execFileSync("git", ["add", "."], { cwd: firstDir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "one"], { cwd: firstDir, encoding: "utf-8" });

  const windows = resolveReleaseTagWindows({
    cwd: firstDir,
    includeOrphaned: true,
    pendingVersion: "1.0.0",
    pendingTimestamp: "2026-05-01T00:00:00Z",
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].heading, "1.0.0 - 2026-05-01");
  assert.equal(windows[0].until, undefined);
});

test("CLI reports missing tag history instead of a stale changelog in a shallow tagless clone", (t) => {
  const { cloneDir } = createShallowClone(t, ["--no-tags"]);
  const cli = join(process.cwd(), "src", "cli.ts");
  const input = join(cloneDir, "items.json");
  writeFileSync(
    input,
    JSON.stringify([
      { id: "pm-current", title: "Current release item", status: "closed", type: "feature", closed_at: "2026-05-05T00:00:00Z" },
    ]),
    "utf-8"
  );
  const args = [
    cli,
    "--input", input,
    "--check",
    "--output", "CHANGELOG.md",
    "--release-version-from-package",
    "--since-previous-tag",
    "--until-release-tag",
  ];

  // The pmc-yzho repro: a depth-1/no-tags checkout must fail with the
  // structured missing-tag-history diagnostic, not with a stale-changelog
  // report for a CHANGELOG.md that is actually correct.
  const shallow = spawnSync(process.execPath, args, { cwd: cloneDir, encoding: "utf-8" });
  assert.equal(shallow.status, 1);
  assert.match(shallow.stderr, /E_MISSING_TAG_HISTORY/);
  assert.match(shallow.stderr, /--since-previous-tag/);
  assert.match(shallow.stderr, /git fetch --tags --unshallow/);
  assert.doesNotMatch(shallow.stderr, /out of date/);

  // The documented recovery restores full tag history and the gate derives the
  // real window again (this clone used --no-tags, so it also unsets tagOpt).
  execFileSync("git", ["config", "--unset", "remote.origin.tagOpt"], { cwd: cloneDir, encoding: "utf-8" });
  execFileSync("git", ["fetch", "--tags", "--unshallow"], { cwd: cloneDir, encoding: "utf-8" });
  assert.equal(gitOutput(cloneDir, ["rev-parse", "--is-shallow-repository"]), "false");
  const recovered = spawnSync(
    process.execPath,
    [cli, "--input", input, "--stdout", "--release-version-from-package", "--since-previous-tag", "--until-release-tag"],
    { cwd: cloneDir, encoding: "utf-8" }
  );
  assert.equal(recovered.status, 0);
  assert.match(recovered.stdout, /## 1\.2\.0 - 2026-05-10/);
  assert.match(recovered.stdout, /Current release item/);
});

test("CLI derives release heading date from explicit version tag", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-explicit-version-date-"));
  const input = join(dir, "items.json");
  const cli = join(process.cwd(), "src", "cli.ts");
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(join(dir, "file.txt"), "release\n", "utf-8");
  execFileSync("git", ["add", "."], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "release"], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-05-15T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-05-15T16:30:00Z",
    },
    encoding: "utf-8",
  });
  execFileSync("git", ["tag", "v2.0.0"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(
    input,
    JSON.stringify([
      {
        id: "pm-explicit",
        title: "Explicit release item",
        status: "closed",
        type: "feature",
        closed_at: "2026-05-15T12:00:00Z",
      },
    ]),
    "utf-8"
  );

  const stdout = execFileSync(process.execPath, [cli, "--input", input, "--stdout", "--version", "2.0.0"], {
    cwd: dir,
    encoding: "utf-8",
  });

  assert.match(stdout, /## 2\.0\.0 - 2026-05-15/);
  assert.match(stdout, /Explicit release item/);
});

test("CLI matches zero-padded calendar release tags for npm versions", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-calendar-tags-"));
  const input = join(dir, "items.json");
  const cli = join(process.cwd(), "src", "cli.ts");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2026.5.24-12" }), "utf-8");
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(join(dir, "file.txt"), "one\n", "utf-8");
  execFileSync("git", ["add", "."], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "one"], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-05-20T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-05-20T00:00:00Z",
    },
    encoding: "utf-8",
  });
  execFileSync("git", ["tag", "v2026.05.24-11"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(join(dir, "file.txt"), "two\n", "utf-8");
  execFileSync("git", ["commit", "-am", "two"], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-05-24T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-05-24T12:00:00Z",
    },
    encoding: "utf-8",
  });
  execFileSync("git", ["tag", "v2026.05.24-12"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(
    input,
    JSON.stringify([
      {
        id: "pm-release",
        title: "Released calendar item",
        status: "closed",
        type: "feature",
        closed_at: "2026-05-24T10:00:00Z",
      },
      {
        id: "pm-after",
        title: "Post tag tracker closure",
        status: "closed",
        type: "task",
        closed_at: "2026-05-24T13:00:00Z",
      },
    ]),
    "utf-8"
  );

  const stdout = execFileSync(
    process.execPath,
    [
      cli,
      "--input",
      input,
      "--stdout",
      "--release-version-from-package",
      "--since-previous-tag",
      "--until-release-tag",
    ],
    {
      cwd: dir,
      encoding: "utf-8",
    }
  );

  assert.match(stdout, /## 2026\.5\.24-12 - 2026-05-24/);
  assert.match(stdout, /Released calendar item/);
  assert.doesNotMatch(stdout, /Post tag tracker closure/);
});


/** Wrap rows in the complete whole-tracker receipt the real CLI emits, so fake
 * runner outputs match the envelope shape the strict list reader requires. */
function completeListAllEnvelope(rows: unknown[]): Record<string, unknown> {
  return {
    items: rows,
    count: rows.length,
    total: rows.length,
    truncated: false,
    has_more: false,
    completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 0 },
    omission_receipt: { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: [] },
  };
}

test("readPmItems supports runner wrappers with custom binaries, args, cwd, and env", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const fixture = join(dir, "fixture.json");
  const wrapper = join(dir, "pm-wrapper.mjs");
  writeFileSync(fixture, JSON.stringify(completeListAllEnvelope(items)), "utf-8");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

if (process.argv.slice(2).join(" ") !== "--pm-path .agents/pm --profile ci --output-budget unbounded --output-limit unbounded list --all --json") process.exit(2);
if (process.env.PM_CHANGELOG_TEST !== "1") process.exit(3);
process.stdout.write(readFileSync(resolve(process.cwd(), "fixture.json"), "utf-8"));
`,
    "utf-8"
  );
  chmodSync(wrapper, 0o755);

  const result = readPmItems({
    pmBin: wrapper,
    pmArgs: ["--profile", "ci"],
    pmRoot: ".agents/pm",
    cwd: dir,
    env: { ...process.env, PM_CHANGELOG_TEST: "1" },
  });

  assert.equal(result.length, 3);
  assert.equal(result[0].id, "pm-2");
});

test("readPmItems supports pm JSON larger than Node's default spawnSync buffer", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const wrapper = join(dir, "pm-wrapper.mjs");
  const largeBody = "x".repeat(1_200_000);
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
if (process.argv.slice(2).join(" ") !== "--output-budget unbounded --output-limit unbounded list --all --json") process.exit(2);
process.stdout.write(JSON.stringify({ items: [{ id: "pm-large", title: "Large tracker", status: "closed", body: ${JSON.stringify(largeBody)} }], count: 1, total: 1, truncated: false, has_more: false, completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 0 }, omission_receipt: { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: [] } }));
`,
    "utf-8"
  );
  chmodSync(wrapper, 0o755);

  const result = readPmItems({ pmBin: wrapper });

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "pm-large");
});

test("readPmItems resolves the installed pm-cli executable without PATH", () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }
  const result = readPmItems({
    pmRoot: join(process.cwd(), ".agents", "pm"),
    env,
  });

  assert.ok(result.length > 0, "expected pm items to be returned without PATH");
});

/** A real canonical `pm list --all --json` envelope captured from the installed CLI
 * against this repository's own tracker, cached so the spawn happens once.
 * Mutating one field of this envelope is how the refusal tests drive each
 * signal from the CLI's real answer shape rather than a hand-written mock. */
let realListAllEnvelope: Record<string, unknown> | undefined;

function captureRealListAllEnvelope(): Record<string, unknown> {
  if (realListAllEnvelope === undefined) {
    const pmBin = join(process.cwd(), "node_modules", ".bin", "pm");
    const result = spawnSync(pmBin, [
      "--pm-path", join(process.cwd(), ".agents", "pm"),
      "--output-budget", "unbounded",
      "--output-limit", "unbounded",
      "list", "--all", "--json",
    ], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `capturing a real canonical list envelope failed: ${result.stderr}`);
    assert.equal(result.stderr, "", "canonical list argv must not emit alias deprecation diagnostics");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.ok(Array.isArray(parsed.items) && parsed.items.length > 0, "the real envelope must carry items");
    assert.equal(parsed.items.length, parsed.count, "the real envelope must return every counted item");
    assert.equal(parsed.count, parsed.total, "the real unbounded read must return the full tracker");
    assert.equal(parsed.truncated, false, "the real unbounded read must not be token-truncated");
    assert.equal(parsed.has_more, false, "the real unbounded read must not require pagination");
    assert.deepEqual(parsed.completeness, {
      status: "complete",
      unreadable_item_count: 0,
      unreadable_directory_count: 0,
    });
    assert.deepEqual(parsed.omission_receipt, {
      has_omissions: false,
      omitted_field_group_count: 0,
      omitted_field_groups: [],
    });
    assert.deepEqual(
      (parsed.read_output as { legacy_aliases_used?: unknown }).legacy_aliases_used,
      [],
      "the real receipt must prove no compatibility alias was used",
    );
    realListAllEnvelope = parsed;
  }
  return realListAllEnvelope;
}

test("readPmItems host controls override bounded caller output controls", () => {
  const rows = readPmItems({
    pmRoot: join(process.cwd(), ".agents", "pm"),
    pmArgs: ["--output-budget", "1", "--output-limit", "1"],
  });
  assert.ok(rows.length > 1, "host-owned unbounded controls must defeat caller-supplied one-item bounds");
  assert.ok(rows.some((row) => row.id === "pmc-6j4o"), "the complete read must contain the delivery item");
});

/** Stringify a mutated copy of the real envelope with exactly one receipt
 * field replaced, keeping every other byte the CLI produced. */
function realEnvelopeWith(override: Record<string, unknown>): string {
  return JSON.stringify({ ...captureRealListAllEnvelope(), ...override });
}

for (const [signal, override, expectedDetail] of [
  ["truncated", { truncated: true }, "truncated=true"],
  ["has_more", { has_more: true }, "has_more=true"],
  ["completeness.status", { completeness: { status: "partial", unreadable_item_count: 2, unreadable_directory_count: 0 } }, 'completeness.status="partial"'],
  ["omission_receipt.has_omissions", { omission_receipt: { has_omissions: true, omitted_field_group_count: 1, omitted_field_groups: ["body"] } }, "omission_receipt.has_omissions=true"],
] as const) {
  test(`parseListAllItemsJson refuses a real whole-tracker envelope whose ${signal} signal tripped`, () => {
    const envelope = captureRealListAllEnvelope();
    const expectedCounts = `count=${envelope.count} of total=${envelope.total}`;
    assert.throws(
      () => parseListAllItemsJson(realEnvelopeWith(override)),
      (error: unknown) => error instanceof IncompleteListAllError
        && error.message.includes(expectedDetail)
        && error.message.includes(expectedCounts),
      `the refusal must name the ${signal} signal and the counts`,
    );
  });
}

test("parseListAllItemsJson refuses answers that carry no completeness receipt", () => {
  // Legacy bare shapes cannot prove completeness; consuming them silently is
  // exactly the 2026.8.14 failure mode.
  for (const output of ["null", "42", JSON.stringify([{ id: "pm-array" }])]) {
    assert.throws(
      () => parseListAllItemsJson(output),
      (error: unknown) => error instanceof IncompleteListAllError
        && /completeness\.status=<missing>/.test(error.message)
        && error.count === undefined
        && error.total === undefined,
      `expected a refusal for ${output}`,
    );
  }
  assert.throws(
    () => parseListAllItemsJson(realEnvelopeWith({ completeness: "broken" })),
    (error: unknown) => error instanceof IncompleteListAllError && /completeness\.status=<missing>/.test(error.message),
  );
});

test("parseListAllItemsJson refuses an envelope whose completeness block is absent", () => {
  const withoutCompleteness = { ...captureRealListAllEnvelope() };
  delete withoutCompleteness.completeness;
  assert.throws(
    () => parseListAllItemsJson(JSON.stringify(withoutCompleteness)),
    (error: unknown) => error instanceof IncompleteListAllError && /completeness\.status=<missing>/.test(error.message),
  );
});

test("parseListAllItemsJson refuses unverifiable or inconsistent receipt counts", () => {
  const envelope = captureRealListAllEnvelope();
  const items = envelope.items as unknown[];
  const count = envelope.count as number;
  for (const [override, expected] of [
    [{ count: undefined }, "count=<missing-or-invalid>"],
    [{ total: -1 }, "total=<missing-or-invalid>"],
    [{ total: count + 1 }, `count=${count} differs from total=${count + 1}`],
    [{ items: items.slice(1) }, `items.length=${items.length - 1} differs from count=${count}`],
  ] as const) {
    assert.throws(
      () => parseListAllItemsJson(realEnvelopeWith(override)),
      (error: unknown) => error instanceof IncompleteListAllError && error.message.includes(expected),
      `expected a refusal naming ${expected}`,
    );
  }
});

test("parseListAllItemsJson names every tripped signal and unknown counts together", () => {
  const withoutCounts = { ...captureRealListAllEnvelope() };
  delete withoutCounts.count;
  delete withoutCounts.total;
  assert.throws(
    () => parseListAllItemsJson(JSON.stringify({ ...withoutCounts, truncated: true, has_more: true })),
    (error: unknown) => error instanceof IncompleteListAllError
      && error.message.includes("truncated=true; has_more=true")
      && error.message.includes("count=unknown of total=unknown"),
  );
});

test("parseListAllItemsJson refuses a complete-looking envelope with no items array", () => {
  assert.throws(
    () => parseListAllItemsJson(realEnvelopeWith({ items: "invalid" })),
    /carried no items array/,
  );
});

test("parseListAllItemsJson lets every item of a real complete envelope flow through unchanged", () => {
  const envelope = captureRealListAllEnvelope();
  const rows = envelope.items as unknown[];
  assert.deepEqual(parseListAllItemsJson(JSON.stringify(envelope)), rows);
});

test("parseListAllItemsJson keeps parsePmItemsJson's behavior for unparseable reads", () => {
  assert.throws(() => parseListAllItemsJson("not-json"), SyntaxError);
});

test("readPmItems surfaces the refusal from a truncated runner answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const wrapper = join(dir, "pm-wrapper.mjs");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(realEnvelopeWith({ truncated: true }))});
`,
    "utf-8"
  );
  chmodSync(wrapper, 0o755);
  try {
    assert.throws(
      () => readPmItems({ pmBin: wrapper }),
      (error: unknown) => error instanceof IncompleteListAllError && error.message.includes("truncated=true"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI can run a custom pm binary", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const wrapper = join(dir, "pm-wrapper.mjs");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
if (process.argv.slice(2).join(" ") !== "--output-budget unbounded --output-limit unbounded list --all --json") process.exit(2);
process.stdout.write(${JSON.stringify(JSON.stringify(completeListAllEnvelope(items)))});
`,
    "utf-8"
  );
  chmodSync(wrapper, 0o755);

  const stdout = execFileSync(
    process.execPath,
    [
      "src/cli.ts",
      "--pm-bin",
      wrapper,
      "--stdout",
      "--version",
      "1.2.0",
      "--date",
      "2026-05-17",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
    }
  );

  assert.match(stdout, /## 1\.2\.0 - 2026-05-17/);
  assert.match(stdout, /- Add GitHub Actions changelog command \(pm-1\)/);
});

test("CLI passes extra pm arguments and cwd to runner wrappers", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const fixture = join(dir, "fixture.json");
  const wrapper = join(dir, "pm-wrapper.mjs");
  writeFileSync(fixture, JSON.stringify(completeListAllEnvelope(items)), "utf-8");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

if (process.argv.slice(2).join(" ") !== "--profile ci --workspace release --output-budget unbounded --output-limit unbounded list --all --json") process.exit(2);
if (!existsSync(resolve(process.cwd(), "fixture.json"))) process.exit(3);
process.stdout.write(readFileSync(resolve(process.cwd(), "fixture.json"), "utf-8"));
`,
    "utf-8"
  );
  chmodSync(wrapper, 0o755);

  const stdout = execFileSync(
    process.execPath,
    [
      "src/cli.ts",
      "--pm-bin",
      wrapper,
      "--pm-arg",
      "--profile",
      "--pm-arg",
      "ci",
      "--pm-arg",
      "--workspace",
      "--pm-arg",
      "release",
      "--pm-cwd",
      dir,
      "--stdout",
      "--version",
      "1.2.0",
      "--date",
      "2026-05-17",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
    }
  );

  assert.match(stdout, /## 1\.2\.0 - 2026-05-17/);
  assert.match(stdout, /- Fix runner status export \(pm-2\)/);
});

test("pm package install activates changelog command", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-install-"));
  t.after(() =>
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  );
  const pmBin = join(process.cwd(), "node_modules", ".bin", "pm");
  const appData = join(dir, "app-data");
  const globalPmPath = join(dir, "global-pm");
  const home = join(dir, "home");
  const localAppData = join(dir, "local-app-data");
  const projectPmPath = join(dir, ".agents", "pm");
  const xdgConfigHome = join(dir, "xdg-config");
  const xdgDataHome = join(dir, "xdg-data");
  mkdirSync(appData);
  mkdirSync(home);
  mkdirSync(localAppData);
  mkdirSync(xdgConfigHome);
  mkdirSync(xdgDataHome);
  const inheritedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    APPDATA: join(dir, "inherited-app-data"),
    INIT_CWD: process.cwd(),
    LOCALAPPDATA: join(dir, "inherited-local-app-data"),
    NODE_AUTH_TOKEN: "must-not-reach-child-processes",
    NODE_OPTIONS: "--require=must-not-reach-child-processes",
    PM_GLOBAL_PATH: join(dir, "inherited-global-pm"),
    PM_PATH: join(dir, "inherited-project-pm"),
  };
  const pmEnv: NodeJS.ProcessEnv = {};
  // Only executable discovery, platform bootstrapping, and locale inputs may
  // be inherited. Code-loading, credential, network, user-config, and terminal
  // variables must remain excluded or be replaced with fixture-owned roots.
  for (const key of [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SystemDrive",
    "ComSpec",
    "WINDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
  ] as const) {
    const value = readEnvironmentValue(inheritedEnv, key);
    if (value !== undefined) pmEnv[key] = value;
  }
  Object.assign(pmEnv, {
    APPDATA: appData,
    HOME: home,
    LOCALAPPDATA: localAppData,
    USERPROFILE: home,
    PM_GLOBAL_PATH: globalPmPath,
    PM_PATH: projectPmPath,
    TEMP: dir,
    TMP: dir,
    TMPDIR: dir,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: xdgDataHome,
  });

  // Prove that hostile npm lifecycle, credential, and pm context values are
  // removed or replaced before any child command sees the environment.
  assert.equal(inheritedEnv.INIT_CWD, process.cwd());
  assert.equal(pmEnv.INIT_CWD, undefined);
  assert.equal(pmEnv.NODE_AUTH_TOKEN, undefined);
  assert.equal(pmEnv.NODE_OPTIONS, undefined);
  assert.equal(pmEnv.APPDATA, appData);
  assert.equal(pmEnv.LOCALAPPDATA, localAppData);
  // Windows treats environment keys case-insensitively, so emitting both PATH
  // and Path would create duplicate logical entries even though Object.keys()
  // reports distinct strings on the parent platform.
  assert.equal(
    Object.keys(pmEnv).filter((key) => key.toUpperCase() === "PATH").length,
    1
  );
  assert.notEqual(inheritedEnv.PM_PATH, projectPmPath);
  assert.equal(pmEnv.PM_PATH, projectPmPath);
  assert.notEqual(inheritedEnv.PM_GLOBAL_PATH, globalPmPath);
  assert.equal(pmEnv.PM_GLOBAL_PATH, globalPmPath);

  execFileSync(pmBin, ["init", "--json"], {
    cwd: dir,
    env: pmEnv,
    encoding: "utf-8",
  });
  execFileSync(pmBin, ["install", process.cwd(), "--project", "--json"], {
    cwd: dir,
    env: pmEnv,
    encoding: "utf-8",
  });

  const doctor = JSON.parse(execFileSync(pmBin, ["package", "doctor", "--project", "--isolated", "--json", "--detail", "deep"], {
    cwd: dir,
    env: pmEnv,
    encoding: "utf-8",
  }));
  // Scoped renderer ownership proves that only changelog command marker results
  // can reach the toon/json callbacks, so isolated doctor remains warning-free.
  assert.deepEqual(doctor.warnings, []);
  assert.equal(doctor.details?.isolation?.isolated, true);
  const installedExtensions = doctor.details?.deep?.installed_extensions;
  assert.ok(Array.isArray(installedExtensions), "installed_extensions should be an array");
  const installedChangelog = installedExtensions.find(
    (extension: { name?: string }) => extension.name === "pm-changelog"
  );
  assert.ok(installedChangelog, "pm-changelog should be present in isolated project diagnostics");
  assert.equal(installedChangelog.activation_status, "ok");
  assert.equal(installedChangelog.runtime_active, true);

  execFileSync(
    pmBin,
    [
      "create",
      "--create-mode",
      "progressive",
      "--type",
      "task",
      "--title",
      "Add changelog install smoke",
      "--description",
      "Verify pm-changelog package install",
      "--status",
      "closed",
      // `governance_require_close_reason` defaults to enabled, so a terminal
      // `closed` transition on `pm create` needs an author-controlled closing
      // summary. `--message` supplies it without weakening the install-smoke
      // assertion the test exists to make.
      "--message",
      "Closed: pm-changelog install smoke verified",
      "--json",
    ],
    {
      cwd: dir,
    env: pmEnv,
      encoding: "utf-8",
    }
  );

  const generated = JSON.parse(execFileSync(
    pmBin,
    [
      "changelog",
      "generate",
      "--output",
      "CHANGELOG.md",
      "--release-version",
      "smoke",
      "--date",
      "2026-05-17",
      "--mode",
      "prepend",
      "--json",
    ],
    {
      cwd: dir,
    env: pmEnv,
      encoding: "utf-8",
    }
  ));

  assert.equal(generated.changed, true);
  assert.equal(generated.item_count, 1);
  assert.match(readFileSync(join(dir, "CHANGELOG.md"), "utf-8"), /## smoke - 2026-05-17/);
  assert.match(readFileSync(join(dir, "CHANGELOG.md"), "utf-8"), /Add changelog install smoke/);

  const unchanged = JSON.parse(execFileSync(
    pmBin,
    [
      "changelog",
      "generate",
      "--output",
      "CHANGELOG.md",
      "--release-version",
      "smoke",
      "--date",
      "2026-05-17",
      "--mode",
      "prepend",
      "--check",
      "--json",
    ],
    {
      cwd: dir,
    env: pmEnv,
      encoding: "utf-8",
    }
  ));
  assert.equal(unchanged.changed, false);

  writeFileSync(join(dir, "CHANGELOG.md"), "# stale\n", "utf-8");
  assert.throws(
    () => execFileSync(
      pmBin,
      [
        "changelog",
        "generate",
        "--output",
        "CHANGELOG.md",
        "--release-version",
        "smoke",
        "--date",
        "2026-05-17",
        "--mode",
        "prepend",
        "--check",
        "--json",
      ],
      {
        cwd: dir,
    env: pmEnv,
        encoding: "utf-8",
      }
    ),
    // The handler throws a PmCliError carrying a numeric exitCode, so the
    // runtime propagates it cleanly (a single invocation) as a command_failed
    // error whose detail is our message — rather than the legacy
    // extension_command_handler_failed fallback that re-invoked the handler.
    /Changelog is out of date/
  );
});

test("pm extension command works when only node cli entrypoint is available", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-node-cli-"));
  const pmCli = join(process.cwd(), "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  const pmBin = join(process.cwd(), "node_modules", ".bin", "pm");
  const pmEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PM_GLOBAL_PATH: join(dir, "global-pm"),
    PM_PATH: join(dir, ".agents", "pm"),
  };

  execFileSync(pmBin, ["init", "pm-cli-website", "--json"], {
    cwd: dir,
    env: pmEnv,
    encoding: "utf-8",
  });
  execFileSync(pmBin, ["install", process.cwd(), "--project", "--json"], {
    cwd: dir,
    env: pmEnv,
    encoding: "utf-8",
  });
  execFileSync(
    pmBin,
    [
      "create",
      "--create-mode",
      "progressive",
      "--type",
      "task",
      "--id",
      "prefix-proof",
      "--title",
      "Generate changelog without global pm",
      "--description",
      "Verify extension can use the current node cli entrypoint",
      "--status",
      "closed",
      // Governance `require_close_reason` defaults to enabled, and this test
      // deliberately runs against the inherited (non-isolated) environment so
      // it exercises the real `.bin/pm` shim. A terminal `closed` transition
      // therefore needs an author-controlled closing summary; `--message`
      // supplies it without weakening the assertion the test exists to make
      // (that the extension command runs through the node CLI entrypoint).
      "--message",
      "Closed: extension command reached via node CLI entrypoint",
      "--json",
    ],
    {
      cwd: dir,
      env: pmEnv,
      encoding: "utf-8",
    }
  );

  const generated = JSON.parse(execFileSync(
    process.execPath,
    [
      pmCli,
      "changelog",
      "generate",
      "--output",
      "CHANGELOG.md",
      "--release-version",
      "node-cli",
      "--date",
      "2026-05-17",
      "--item-url-base",
      "https://example.com/pm",
      "--json",
    ],
    {
      cwd: dir,
      encoding: "utf-8",
      env: { ...pmEnv, PATH: dirname(process.execPath) },
    }
  ));

  assert.equal(generated.changed, true);
  assert.ok(generated.item_count >= 1);
  const markdown = readFileSync(join(dir, "CHANGELOG.md"), "utf-8");
  assert.match(markdown, /## node-cli - 2026-05-17/);
  assert.match(markdown, /Generate changelog without global pm/);
  assert.ok(markdown.includes(
    "[pm-cli-website-prefix-proof](https://example.com/pm/tasks/pm-cli-website-prefix-proof.toon)"
  ));
});

test("createChangelog: CLI-flag tokens in titles do not falsely classify Issues as Added", () => {
  const issueWithAddFlag = [
    {
      id: "pm-cli-flag-issue",
      title: "pm comments/notes --add HTML-escapes angle brackets in stored text",
      status: "closed",
      type: "Issue",
      release: "1.2.0",
      updated_at: "2026-05-28T09:00:00Z",
    },
  ];
  const result = createChangelog({ items: issueWithAddFlag, version: "1.2.0", date: "2026-05-28" });
  assert.match(result.markdown, /### Fixed\n\n- pm comments\/notes/);
  assert.doesNotMatch(result.markdown, /### Added\n\n- pm comments\/notes/);
});

test("createChangelog: Issue type defaults to Fixed when no keyword matches", () => {
  const descriptiveIssue = [
    {
      id: "pm-descriptive",
      title: "Calendar disagreement on weekend boundaries",
      status: "closed",
      type: "Issue",
      release: "1.2.0",
      updated_at: "2026-05-28T09:00:00Z",
    },
  ];
  const result = createChangelog({ items: descriptiveIssue, version: "1.2.0", date: "2026-05-28" });
  assert.match(result.markdown, /### Fixed\n\n- Calendar disagreement/);
  assert.doesNotMatch(result.markdown, /### Other/);
});

test("createChangelog: title-only Added and Changed keywords in Issues still route to Fixed", () => {
  // Regression: title-only Added and Changed keywords in Issue descriptions of
  // broken commands or requested graph evidence must not override the Issue
  // default.
  const ambiguousTitleIssues = [
    { id: "pm-u", title: "pm update doesn't accept --expected/--actual aliases that pm close accepts", type: "Issue" },
    { id: "pm-c", title: "pm update change is not applied to nested items", type: "Issue" },
    { id: "pm-changed", title: "Changed graph evidence drops canonical edge counts", type: "Issue" },
    { id: "pm-refactor", title: "Refactor graph evidence loses canonical edge counts", type: "Issue" },
    { id: "pm-updated", title: "Updated graph evidence drops canonical edge counts", type: "Issue" },
    { id: "pm-improve", title: "Improve graph evidence without losing canonical edge counts", type: "Issue" },
    { id: "pm-a", title: "Add graph composition to evidence without changing canonical edge counts", type: "Issue" },
    { id: "pm-n", title: "New retry command expands shell input before pm can validate it", type: "Issue" },
    { id: "pm-f", title: "Feature graph composition drops canonical edge counts", type: "Issue" },
    { id: "pm-feat", title: "feat graph composition drops canonical edge counts", type: "Issue" },
    { id: "pm-added", title: "Added graph composition drops canonical edge counts", type: "Issue" },
  ].map((entry) => ({
    ...entry,
    status: "closed",
    release: "1.2.0",
    updated_at: "2026-05-28T09:00:00Z",
  }));
  const result = createChangelog({ items: ambiguousTitleIssues, version: "1.2.0", date: "2026-05-28" });
  const fixedSectionMatch = result.markdown.match(/### Fixed\n\n[\s\S]*?(?=\n### |\n## |$)/);
  assert.ok(fixedSectionMatch, "### Fixed section must be present in the changelog");
  const fixedSection = fixedSectionMatch[0];
  for (const issue of ambiguousTitleIssues) {
    assert.ok(fixedSection.includes(issue.title), `${issue.id} must be inside the Fixed section`);
  }
  assert.doesNotMatch(result.markdown, /### Added/);
  assert.doesNotMatch(result.markdown, /### Changed/);
});

test("createChangelog: explicit refactor/change tag wins over the Issue→Fixed default", () => {
  // The bug-like-type default must not swallow a STRONG (tag) Changed signal —
  // an Issue the author deliberately tagged `refactor` should land in Changed,
  // mirroring how an explicit `feature` tag routes to Added.
  const taggedRefactorIssue = [
    {
      id: "pm-refactor",
      title: "Consolidate the duplicated parser helpers",
      status: "closed",
      type: "Issue",
      tags: ["refactor"],
      release: "1.2.0",
      updated_at: "2026-05-28T09:00:00Z",
    },
  ];
  const result = createChangelog({ items: taggedRefactorIssue, version: "1.2.0", date: "2026-05-28" });
  assert.match(result.markdown, /### Changed\n\n- Consolidate the duplicated parser helpers/);
  assert.doesNotMatch(result.markdown, /### Fixed/);
});

test("createChangelog: non-string item type does not throw and falls back gracefully", () => {
  // Defensive: malformed trackers can carry a non-string `type`. The classifier
  // must not call .toLowerCase() on it. With no usable type/keyword signal the
  // item lands in Other rather than crashing.
  const malformed = [
    {
      id: "pm-weird",
      title: "Mysterious entry with no keyword",
      status: "closed",
      type: 42 as unknown as string,
      release: "1.2.0",
      updated_at: "2026-05-28T09:00:00Z",
    },
  ];
  const result = createChangelog({ items: malformed, version: "1.2.0", date: "2026-05-28" });
  assert.match(result.markdown, /### Other\n\n- Mysterious entry/);
});

test("createChangelog: non-bug types still classify as Changed via update/refactor keywords", () => {
  // The reorder must NOT swallow genuine Changed work on non-bug types — e.g. a
  // chore titled "update dependency …" should remain under Changed.
  const choreUpdate = [
    {
      id: "pm-dep",
      title: "update dependency typescript to 5.6",
      status: "closed",
      type: "chore",
      release: "1.2.0",
      updated_at: "2026-05-28T09:00:00Z",
    },
  ];
  const result = createChangelog({ items: choreUpdate, version: "1.2.0", date: "2026-05-28" });
  assert.match(result.markdown, /### Changed\n\n- update dependency typescript/);
});

test("createChangelog: remove/delete command-name terms in feature titles do not misroute to Removed", () => {
  const schemaPlan = [
    {
      id: "pm-schema",
      title: "Complete schema customization epic: remove-type, add-status, per-type workflows, config create_default_type",
      status: "closed",
      type: "Plan",
      release: "1.2.0",
      updated_at: "2026-06-07T10:00:00Z",
    },
  ];
  const result = createChangelog({ items: schemaPlan, version: "1.2.0", date: "2026-06-07" });
  assert.doesNotMatch(result.markdown, /### Removed/);
  assert.match(result.markdown, /### Added[\s\S]*remove-type/);
});

test("createChangelog: explicit strong removal signals still route to Removed", () => {
  const explicitRemoval = [
    {
      id: "pm-remove",
      title: "Stabilize schema action list parser",
      status: "closed",
      type: "Task",
      tags: ["remove"],
      release: "1.2.0",
      updated_at: "2026-06-07T10:00:00Z",
    },
  ];
  const result = createChangelog({ items: explicitRemoval, version: "1.2.0", date: "2026-06-07" });
  assert.match(result.markdown, /### Removed\n\n- Stabilize schema action list parser/);
});

test("createChangelog: explicit feature tag still wins over Issue→Fixed default", () => {
  // The title intentionally avoids the keyword "add" so the only signal that
  // routes this to "Added" is the explicit `feature` tag — that's the
  // behavior we want to lock down.
  const issueWithFeatureTag = [
    {
      id: "pm-tagged",
      title: "Darkmode theme switcher",
      status: "closed",
      type: "Issue",
      tags: ["feature"],
      release: "1.2.0",
      updated_at: "2026-05-28T09:00:00Z",
    },
  ];
  const result = createChangelog({ items: issueWithFeatureTag, version: "1.2.0", date: "2026-05-28" });
  assert.match(result.markdown, /### Added\n\n- Darkmode theme switcher/);
});

test("createChangelog: CLI-flag stripping handles all the messy forms users write", () => {
  // Each variant carries an "add"-looking substring that would falsely route
  // to Added if the stripper missed it. The pattern must:
  //  - strip `--flag=value` wholesale (not just `--flag`)
  //  - strip URL/path values: `--url=https://example.com/add` wholesale
  //  - strip single-dash POSIX shorts (`-add`)
  //  - strip flags starting with a digit (`--2add`)
  //  - strip flags wrapped in quotes / parens / brackets — `\`--add\``,
  //    `(--add)`, `[--add]`
  //  - leave in-word hyphens alone so legitimate text like "non-add" is kept
  //    AND so descriptive Issue titles still fall through to the Issue→Fixed
  //    default (the "non-add issue" item should land in Fixed by default)
  for (const title of [
    "pm cmd --add=true causes corruption",
    "pm cmd --url=https://example.com/add returns 500",
    "pm cmd -add short alias dropped",
    "pm cmd --2add unexpected exit",
    "pm comments `--add` corrupts text",
    "pm comments (--add) corrupts text",
    "pm comments [--add] corrupts text",
  ]) {
    const result = createChangelog({
      items: [{ id: "pm-x", title, status: "closed", type: "Issue", release: "1.2.0", updated_at: "2026-05-28T09:00:00Z" }],
      version: "1.2.0",
      date: "2026-05-28",
    });
    assert.match(result.markdown, /### Fixed\n/, `failed to route to Fixed for title: ${title}`);
    assert.doesNotMatch(result.markdown, /### Added\n/, `unexpectedly routed to Added for title: ${title}`);
  }
});

test("createChangelog: `Bug` / `Bugfix` / `Defect` types also default to Fixed", () => {
  for (const type of ["bug", "Bug", "Bugfix", "Defect"]) {
    const result = createChangelog({
      items: [{ id: "pm-x", title: "Crash on cold-start", status: "closed", type, release: "1.2.0", updated_at: "2026-05-28T09:00:00Z" }],
      version: "1.2.0",
      date: "2026-05-28",
    });
    assert.match(result.markdown, /### Fixed\n\n- Crash on cold-start/);
  }
});

test("resolveReleaseTagWindows keeps an invalid-timestamp pending release leading deterministically", (t) => {
  // The pending timestamp supplies a stable display date, not its ownership
  // position. Even an invalid or stale value must not sort the release being
  // cut behind a real tag and create overlapping windows. Run repeatedly to
  // prove the resulting order does not depend on Date.parse(NaN) behavior.
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-invalid-ts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "pm changelog test"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "pm-changelog@example.com"], { cwd: dir, encoding: "utf-8" });
  // Create a valid tag on main with a parseable timestamp.
  writeFileSync(join(dir, "file.txt"), "one\n");
  execFileSync("git", ["add", "file.txt"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "one"], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-07-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-07-01T12:00:00Z" },
  });
  execFileSync("git", ["tag", "v2026.7.1"], { cwd: dir, encoding: "utf-8" });

  // Run the sort multiple times to detect non-determinism.
  const allHeadings: string[][] = [];
  for (let i = 0; i < 100; i++) {
    const windows = resolveReleaseTagWindows({
      cwd: dir,
      pendingVersion: "2026.7.8",
      // Invalid timestamp that Date.parse cannot parse
      pendingTimestamp: "not-a-parseable-date-value",
    });
    const headings = windows.map((w) => w.heading);
    allHeadings.push(headings);
  }

  // Verify every iteration produces the same heading order.
  for (let i = 1; i < allHeadings.length; i++) {
    assert.deepEqual(allHeadings[i], allHeadings[0]);
  }

  // The pending release leads and replaces Unreleased even though its display
  // timestamp cannot be compared with the existing tag timestamp.
  assert.equal(allHeadings[0].length, 2);
  assert.match(allHeadings[0][0], /2026\.7\.8/);
  assert.match(allHeadings[0][1], /2026\.7\.1/);
});

test("resolveReleaseTagWindows keeps a stale pending display timestamp open and non-overlapping", (t) => {
  // A pending display timestamp older than a real tag must not move the release
  // being cut behind that tag. The pending window still leads and owns all work
  // after the newest real release boundary.
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-all-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "pm changelog test"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "pm-changelog@example.com"], { cwd: dir, encoding: "utf-8" });

  writeFileSync(join(dir, "file.txt"), "one\n");
  execFileSync("git", ["add", "file.txt"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "one"], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-07-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-07-01T12:00:00Z" },
  });
  execFileSync("git", ["tag", "v2026.7.1"], { cwd: dir, encoding: "utf-8" });

  const resultA = resolveReleaseTagWindows({
    cwd: dir,
    pendingVersion: "2026.6.1",
    pendingTimestamp: "2026-06-01T00:00:00Z",
  });
  const resultB = resolveReleaseTagWindows({
    cwd: dir,
    pendingVersion: "2026.6.1",
    pendingTimestamp: "2026-06-01T00:00:00Z",
  });

  // Same inputs must produce identical output.
  assert.deepEqual(
    resultA.map((w) => w.heading),
    resultB.map((w) => w.heading)
  );
  assert.equal(resultA.length, 2);
  assert.match(resultA[0].heading, /2026\.6\.1/);
  assert.equal(resultA[0].since, "2026-07-01T12:00:00.000Z");
  assert.equal(resultA[0].until, undefined);
  assert.match(resultA[1].heading, /2026\.7\.1/);
  assert.equal(resultA[1].until, "2026-07-01T12:00:00.000Z");
});

test("resolveReleaseTagWindows uses locale-independent tag-name tie-breaks", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-name-order-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "pm changelog test"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "pm-changelog@example.com"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(join(dir, "file.txt"), "same timestamp\n");
  execFileSync("git", ["add", "file.txt"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "same timestamp"], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-07-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-07-01T12:00:00Z" },
  });
  execFileSync("git", ["tag", "vZeta"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["tag", "vAlpha"], { cwd: dir, encoding: "utf-8" });

  const headings = resolveReleaseTagWindows({ cwd: dir }).map((window) => window.heading);

  assert.match(headings[1], /^Alpha /);
  assert.match(headings[2], /^Zeta /);
});

// --- Release attribution (`respectItemRelease`) --------------------------------
// A tracker whose fix shipped in release X but whose item is closed during a
// later release must not be re-dated into the current window. `--all-release-tags`
// already pins by the release field; these tests cover the single-window path.

type AttributionItem = Parameters<typeof createChangelog>[0]["items"][number];

const shippedElsewhere: AttributionItem = {
  id: "pm-shipped",
  title: "Fix trailing newline",
  status: "closed",
  type: "Issue",
  release: "2026.6.1",
  closed_at: "2026-07-24T10:00:00Z",
};
const shippedHere: AttributionItem = {
  id: "pm-current",
  title: "Add release attribution",
  status: "closed",
  type: "Feature",
  release: "2026.7.24",
  closed_at: "2026-07-24T11:00:00Z",
};
const undeclared: AttributionItem = {
  id: "pm-plain",
  title: "Tidy docs",
  status: "closed",
  type: "Task",
  closed_at: "2026-07-24T12:00:00Z",
};

test("default single-window generation keeps ignoring the release field (byte-identical)", () => {
  const { markdown } = createChangelog({
    items: [shippedElsewhere, shippedHere, undeclared],
    version: "2026.7.24",
    date: "2026-07-24",
    since: "2026-07-24T00:00:00Z",
  });
  assert.match(markdown, /Fix trailing newline/);
  assert.match(markdown, /Add release attribution/);
  assert.match(markdown, /Tidy docs/);
});

test("respectItemRelease drops items pinned to another release from the version window", () => {
  const { markdown } = createChangelog({
    items: [shippedElsewhere, shippedHere, undeclared],
    version: "2026.7.24",
    date: "2026-07-24",
    since: "2026-07-24T00:00:00Z",
    respectItemRelease: true,
  });
  assert.doesNotMatch(markdown, /Fix trailing newline/);
  assert.match(markdown, /Add release attribution/);
  assert.match(markdown, /Tidy docs/);
});

test("respectItemRelease keeps a matching item whose timestamps fall outside the window", () => {
  const closedLate: AttributionItem = { ...shippedHere, closed_at: "2026-09-01T00:00:00Z" };
  const { markdown } = createChangelog({
    items: [closedLate],
    version: "2026.7.24",
    date: "2026-07-24",
    since: "2026-07-01T00:00:00Z",
    until: "2026-07-31T00:00:00Z",
    respectItemRelease: true,
  });
  assert.match(markdown, /Add release attribution/);
});

test("respectItemRelease normalizes a leading v on either side of the comparison", () => {
  const { markdown } = createChangelog({
    items: [{ ...shippedHere, release: "v2026.7.24" }],
    version: "2026.7.24",
    date: "2026-07-24",
    respectItemRelease: true,
  });
  assert.match(markdown, /Add release attribution/);
});

test("respectItemRelease reads the release from item metadata as a fallback", () => {
  const metadataOnly: AttributionItem = {
    id: "pm-meta",
    title: "Metadata release only",
    status: "closed",
    type: "Issue",
    closed_at: "2026-07-24T10:00:00Z",
    metadata: { release: "2026.6.1" },
  };
  const { markdown } = createChangelog({
    items: [metadataOnly],
    version: "2026.7.24",
    date: "2026-07-24",
    respectItemRelease: true,
  });
  assert.doesNotMatch(markdown, /Metadata release only/);
});

test("respectItemRelease excludes declared releases from an unversioned (Unreleased) window", () => {
  const { markdown } = createChangelog({
    items: [shippedElsewhere, undeclared],
    date: "2026-07-24",
    respectItemRelease: true,
  });
  assert.doesNotMatch(markdown, /Fix trailing newline/);
  assert.match(markdown, /Tidy docs/);
});

test("respectItemRelease never strips items from groupBy release/milestone grouping", () => {
  const { markdown: grouped } = createChangelog({
    items: [shippedElsewhere, shippedHere],
    groupBy: "release",
    respectItemRelease: true,
  });
  assert.match(grouped, /## 2026\.6\.1/);
  assert.match(grouped, /## 2026\.7\.24/);
  assert.match(grouped, /Fix trailing newline/);
});

test("respectItemRelease leaves the --all-release-tags path untouched", () => {
  const windows = [
    { heading: "2026.7.24 - 2026-07-24", releaseTag: "v2026.7.24", since: "2026-07-01T00:00:00Z", until: "2026-07-31T00:00:00Z" },
    { heading: "2026.6.1 - 2026-06-01", releaseTag: "v2026.6.1", since: "2026-06-01T00:00:00Z", until: "2026-06-30T00:00:00Z" },
  ];
  const { markdown: withFlag } = createChangelog({ items: [shippedElsewhere, shippedHere], releaseWindows: windows, respectItemRelease: true });
  const { markdown: withoutFlag } = createChangelog({ items: [shippedElsewhere, shippedHere], releaseWindows: windows });
  assert.equal(withFlag, withoutFlag);
  assert.match(withFlag, /## 2026\.6\.1 - 2026-06-01\n\n### Fixed\n\n- Fix trailing newline/);
});

// --- Authoritative completion-timestamp provenance (SDK resolveCompletionTimestamp) ---
// The hand-rolled completed_at ?? closed_at ?? updated_at ?? created_at chain was
// replaced by the pm-cli SDK resolver. These tests pin the contract: every
// `source` value, the all-absent `created_at` final fallback, and the
// inferred-vs-authoritative report that lets a maintainer catch a
// shipped-but-late-closed item.

test("itemTimestamp resolves completed_at as the authoritative source (fallback false)", () => {
  // A fix that shipped on the 18th but whose tracker was closed on the 20th must
  // land in the release window containing the 18th, not the 20th.
  const { markdown } = createChangelog({
    items: [
      {
        id: "pm-authoritative",
        title: "Shipped before delayed closeout",
        status: "closed",
        type: "feature",
        completed_at: "2026-05-17T12:00:00Z",
        closed_at: "2026-05-20T12:00:00Z",
      },
    ],
    releaseWindows: [
      { heading: "Unreleased", since: "2026-05-18T00:00:00Z", sinceExclusive: true },
      { heading: "1.2.0 - 2026-05-17", until: "2026-05-18T00:00:00Z" },
    ],
  });
  assert.match(markdown, /## 1\.2\.0 - 2026-05-17[\s\S]*Shipped before delayed closeout/);
  assert.doesNotMatch(markdown, /## Unreleased[\s\S]*Shipped before delayed closeout/);
});

test("itemTimestamp resolves closed_at as an inferred fallback (fallback true)", () => {
  // No completed_at: closed_at is used but is an inferred attribution.
  const { markdown } = createChangelog({
    items: [
      {
        id: "pm-closed-fallback",
        title: "Legacy close-time item",
        status: "closed",
        type: "bug",
        closed_at: "2026-05-18T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      },
    ],
    releaseWindows: [
      { heading: "Unreleased", since: "2026-05-19T00:00:00Z", sinceExclusive: true },
      { heading: "1.2.0 - 2026-05-18", until: "2026-05-19T00:00:00Z" },
    ],
  });
  assert.match(markdown, /## 1\.2\.0 - 2026-05-18[\s\S]*Legacy close-time item/);
});

test("itemTimestamp resolves updated_at as an inferred fallback when closed_at is absent", () => {
  // Only updated_at present: the SDK chain falls through to updated_at.
  const { markdown } = createChangelog({
    items: [
      {
        id: "pm-updated-fallback",
        title: "Updated-only item",
        status: "closed",
        type: "task",
        updated_at: "2026-05-18T12:00:00Z",
      },
    ],
    releaseWindows: [
      { heading: "Unreleased", since: "2026-05-19T00:00:00Z", sinceExclusive: true },
      { heading: "1.2.0 - 2026-05-18", until: "2026-05-19T00:00:00Z" },
    ],
  });
  assert.match(markdown, /## 1\.2\.0 - 2026-05-18[\s\S]*Updated-only item/);
});

test("itemTimestamp falls back to created_at when completed_at, closed_at, and updated_at are all absent", () => {
  // The SDK chain returns no timestamp when all three lifecycle fields are
  // absent; pm-changelog keeps created_at as the final local fallback so the
  // item is still placeable. This must not regress.
  const { markdown } = createChangelog({
    items: [
      {
        id: "pm-created-fallback",
        title: "Ancient record predating lifecycle fields",
        status: "closed",
        type: "task",
        created_at: "2026-05-18T12:00:00Z",
      },
    ],
    releaseWindows: [
      { heading: "Unreleased", since: "2026-05-19T00:00:00Z", sinceExclusive: true },
      { heading: "1.2.0 - 2026-05-18", until: "2026-05-19T00:00:00Z" },
    ],
  });
  assert.match(markdown, /## 1\.2\.0 - 2026-05-18[\s\S]*Ancient record predating lifecycle fields/);
});

test("itemTimestamp returns undefined (unplaceable) when no timestamp field is present at all", () => {
  // No timestamp of any kind: the item cannot be placed by time and is excluded
  // from a bounded window rather than silently dropped into the wrong release.
  const { markdown } = createChangelog({
    items: [
      { id: "pm-no-time", title: "Timestampless item", status: "closed", type: "task" },
    ],
    releaseWindows: [
      { heading: "Unreleased", since: "2026-05-19T00:00:00Z", sinceExclusive: true },
      { heading: "1.2.0 - 2026-05-18", until: "2026-05-19T00:00:00Z" },
    ],
  });
  assert.doesNotMatch(markdown, /Timestampless item/);
});

test("unresolved SDK completion never fabricates a date or credits a field that supplied nothing", () => {
  // Since pm-cli 2026.8.3 the SDK resolver returns an explicit unresolved arm
  // (`resolved: false`) when completed_at, closed_at and updated_at are all
  // absent. Such an item must stay undated: it survives only an unbounded
  // window, and the provenance report keys it under "none" rather than
  // crediting created_at (or any lifecycle field) with a value it never
  // supplied - the anti-fabrication guarantee filterItemsByTime relies on.
  const undated = {
    id: "pm-unresolved",
    title: "Record carrying no completion signal",
    status: "closed",
    type: "task",
  };
  const report = explainChangelogSelection({
    items: [undated],
    version: "2026.7.24",
    date: "2026-07-24",
  });
  assert.equal(report.stage_counts.visible_items, 1);
  const provenance = report.attribution_provenance;
  assert.ok(provenance, "attribution_provenance must be present when items are visible");
  assert.equal(provenance.authoritative, 0);
  assert.equal(provenance.inferred, 1);
  assert.equal(provenance.inferred_sources.none, 1);
  assert.equal(provenance.inferred_sources.created_at ?? 0, 0);
  assert.equal(provenance.inferred_sources.completed_at ?? 0, 0);
  assert.equal(provenance.inferred_sources.closed_at ?? 0, 0);
  assert.equal(provenance.inferred_sources.updated_at ?? 0, 0);
  assert.ok(provenance.inferred_sample.some((label) => label.startsWith("pm-unresolved")));

  // The provenance bookkeeping above only proves how the item was LABELLED.
  // The guarantee that actually matters is behavioural: an item no lifecycle
  // field could date must be unplaceable in time, so a bounded window must
  // exclude it. Without a since/until there is no time filtering at all, so
  // the assertions above would still pass if an undated item were silently
  // treated as in-window.
  const bounded = explainChangelogSelection({
    items: [undated],
    version: "2026.7.24",
    date: "2026-07-24",
    since: "2026-07-01T00:00:00Z",
    until: "2026-07-31T00:00:00Z",
  });
  assert.equal(
    bounded.stage_counts.visible_items,
    0,
    "an item with no resolvable completion timestamp must not appear in a bounded window",
  );
});

test("unresolved SDK completion still falls back to created_at for legacy records", () => {
  // The unresolved arm (`resolved: false`) only means no LIFECYCLE field
  // supplied a timestamp; pm-changelog's created_at final fallback must still
  // place legacy records that predate the lifecycle fields, reported as an
  // inferred created_at attribution rather than an SDK-sourced one.
  const legacyRecord = {
    id: "pm-legacy-created",
    title: "Legacy record with only created_at",
    status: "closed",
    type: "task",
    created_at: "2026-07-24T09:00:00Z",
  };
  const report = explainChangelogSelection({
    items: [legacyRecord],
    version: "2026.7.24",
    date: "2026-07-24",
  });
  const provenance = report.attribution_provenance;
  assert.ok(provenance);
  assert.equal(provenance.authoritative, 0);
  assert.equal(provenance.inferred, 1);
  assert.equal(provenance.inferred_sources.created_at, 1);
  assert.equal(provenance.inferred_sources.none ?? 0, 0);

  // The complement of the unresolved case: the created_at fallback is only
  // useful if it actually PLACES the record, so a bounded window containing
  // created_at must include it — and one that excludes that date must not.
  // Asserting both directions proves the fallback supplies a real timestamp
  // rather than merely being reported as one.
  const inWindow = explainChangelogSelection({
    items: [legacyRecord],
    version: "2026.7.24",
    date: "2026-07-24",
    since: "2026-07-01T00:00:00Z",
    until: "2026-07-31T00:00:00Z",
  });
  assert.equal(
    inWindow.stage_counts.visible_items,
    1,
    "a legacy record must be placed by its created_at fallback",
  );
  const outOfWindow = explainChangelogSelection({
    items: [legacyRecord],
    version: "2026.7.24",
    date: "2026-07-24",
    since: "2026-08-01T00:00:00Z",
    until: "2026-08-31T00:00:00Z",
  });
  assert.equal(
    outOfWindow.stage_counts.visible_items,
    0,
    "the created_at fallback must respect window bounds, not bypass them",
  );
});

test("explainChangelogSelection reports authoritative vs inferred attribution provenance", () => {
  const report = explainChangelogSelection({
    items: [
      {
        id: "pm-authoritative",
        title: "Authoritative completed item",
        status: "closed",
        type: "feature",
        completed_at: "2026-07-24T10:00:00Z",
        closed_at: "2026-07-26T10:00:00Z",
      },
      {
        id: "pm-closed-inferred",
        title: "Closed-only inferred item",
        status: "closed",
        type: "bug",
        closed_at: "2026-07-24T11:00:00Z",
      },
      {
        id: "pm-updated-inferred",
        title: "Updated-only inferred item",
        status: "closed",
        type: "task",
        updated_at: "2026-07-24T12:00:00Z",
      },
      {
        id: "pm-created-inferred",
        title: "Created-only inferred item",
        status: "closed",
        type: "task",
        created_at: "2026-07-24T13:00:00Z",
      },
    ],
    version: "2026.7.24",
    date: "2026-07-24",
    since: "2026-07-24T00:00:00Z",
  });
  const provenance = report.attribution_provenance;
  assert.ok(provenance, "attribution_provenance must be present when items are visible");
  assert.equal(provenance.authoritative, 1);
  assert.equal(provenance.inferred, 3);
  assert.equal(provenance.inferred_sources.closed_at, 1);
  assert.equal(provenance.inferred_sources.updated_at, 1);
  assert.equal(provenance.inferred_sources.created_at, 1);
  // The inferred sample names the items a maintainer should inspect.
  assert.equal(provenance.inferred_sample.length, 3);
  assert.ok(provenance.inferred_sample.some((label) => label.startsWith("pm-closed-inferred")));
  assert.ok(provenance.inferred_sample.some((label) => label.startsWith("pm-updated-inferred")));
  assert.ok(provenance.inferred_sample.some((label) => label.startsWith("pm-created-inferred")));
  // A hint surfaces the inferred attribution so it is actionable in --explain output.
  assert.ok(
    report.hints.some((hint) => /3 visible item\(s\) were attributed.*inferred timestamp.*closed_at,created_at,updated_at/.test(hint)),
    `expected an inferred-attribution hint, got: ${JSON.stringify(report.hints)}`,
  );
});

test("explainChangelogSelection reports all-authoritative provenance with no inferred sample", () => {
  const report = explainChangelogSelection({
    items: [
      { id: "pm-a", title: "Authoritative one", status: "closed", type: "feature", completed_at: "2026-07-24T10:00:00Z" },
      { id: "pm-b", title: "Authoritative two", status: "closed", type: "feature", completed_at: "2026-07-24T11:00:00Z" },
    ],
    version: "2026.7.24",
    date: "2026-07-24",
    since: "2026-07-24T00:00:00Z",
  });
  const provenance = report.attribution_provenance;
  assert.ok(provenance);
  assert.equal(provenance.authoritative, 2);
  assert.equal(provenance.inferred, 0);
  assert.equal(provenance.inferred_sample.length, 0);
  assert.equal(Object.keys(provenance.inferred_sources).length, 0);
  // No inferred-attribution hint when everything is authoritative.
  assert.ok(!report.hints.some((hint) => /inferred timestamp/.test(hint)));
});

test("explainChangelogSelection omits attribution_provenance when no items are visible", () => {
  const report = explainChangelogSelection({
    items: [],
    version: "2026.7.24",
    date: "2026-07-24",
  });
  assert.equal(report.attribution_provenance, undefined);
});

test("attribution provenance distinguishes a shipped-but-late-closed item in the report", () => {
  // The canonical failure: work shipped in release N (completed_at) but the
  // tracker was closed in release N+1 (closed_at). Without the authoritative
  // completed_at the item would be dated into N+1. The provenance must flag it
  // as authoritative (not inferred) so the maintainer knows the placement is
  // correct, and would flag the inverse (closed_at-only) as inferred.
  const shippedLateClosed = {
    id: "pm-shipped-late",
    title: "Fix shipped in N, closed in N+1",
    status: "closed",
    type: "feature",
    completed_at: "2026-06-15T10:00:00Z",
    closed_at: "2026-07-24T10:00:00Z",
  };
  const report = explainChangelogSelection({
    items: [shippedLateClosed],
    version: "2026.6.15",
    date: "2026-06-15",
    since: "2026-06-01T00:00:00Z",
    until: "2026-06-30T00:00:00Z",
  });
  const provenance = report.attribution_provenance;
  assert.ok(provenance);
  assert.equal(provenance.authoritative, 1);
  assert.equal(provenance.inferred, 0);
  // The item lands in the June window (completed_at), not July (closed_at).
  assert.equal(report.stage_counts.visible_items, 1);
});

// --- Tag exclusion (`excludeTags`) -------------------------------------------

test("excludeTags omits items carrying any listed tag, case- and space-insensitively", () => {
  const items: AttributionItem[] = [
    { id: "pm-a", title: "Real change", status: "closed", type: "Feature", closed_at: "2026-07-24T10:00:00Z", tags: ["feature"] },
    { id: "pm-b", title: "Upstream tracker", status: "closed", type: "Issue", closed_at: "2026-07-24T10:00:00Z", tags: [" Changelog:Ignore "] },
  ];
  const { markdown } = createChangelog({ items, version: "2026.7.24", date: "2026-07-24", excludeTags: ["changelog:ignore"] });
  assert.match(markdown, /Real change/);
  assert.doesNotMatch(markdown, /Upstream tracker/);
});

test("excludeTags is inert when empty or when items carry no tags", () => {
  const items: AttributionItem[] = [
    { id: "pm-a", title: "Real change", status: "closed", type: "Feature", closed_at: "2026-07-24T10:00:00Z" },
  ];
  const baseline = createChangelog({ items, version: "2026.7.24", date: "2026-07-24" }).markdown;
  assert.equal(createChangelog({ items, version: "2026.7.24", date: "2026-07-24", excludeTags: [] }).markdown, baseline);
  assert.equal(createChangelog({ items, version: "2026.7.24", date: "2026-07-24", excludeTags: ["  ", ""] }).markdown, baseline);
  assert.equal(createChangelog({ items, version: "2026.7.24", date: "2026-07-24", excludeTags: ["other"] }).markdown, baseline);
});

test("excludeTags applies to the release-window history path as well", () => {
  const items: AttributionItem[] = [
    { id: "pm-a", title: "Real change", status: "closed", type: "Feature", closed_at: "2026-06-15T10:00:00Z" },
    { id: "pm-b", title: "Upstream tracker", status: "closed", type: "Issue", closed_at: "2026-06-15T10:00:00Z", tags: ["changelog:ignore"] },
  ];
  const { markdown } = createChangelog({
    items,
    releaseWindows: [{ heading: "2026.6.1 - 2026-06-30", releaseTag: "v2026.6.1", since: "2026-06-01T00:00:00Z", until: "2026-06-30T00:00:00Z" }],
    excludeTags: ["changelog:ignore"],
  });
  assert.match(markdown, /Real change/);
  assert.doesNotMatch(markdown, /Upstream tracker/);
});

test("excludeTags tolerates malformed non-array tags instead of throwing", () => {
  // Real workspaces carry `tags` as a bare string; `--section-by label` already
  // tolerates it, so the exclude filter must not be the one path that crashes.
  const malformed = {
    id: "pm-bad",
    title: "Malformed tags",
    status: "closed",
    type: "Issue",
    closed_at: "2026-07-24T10:00:00Z",
    tags: "changelog:ignore" as unknown as string[],
  };
  const { markdown } = createChangelog({
    items: [malformed],
    version: "2026.7.24",
    date: "2026-07-24",
    excludeTags: ["changelog:ignore"],
  });
  // Not silently excluded either: a non-array value carries no matchable tag.
  assert.match(markdown, /Malformed tags/);
});

test("explainChangelogSelection counts release-pinned items apart from timestamp attribution", () => {
  // Under --respect-item-release on a single-version section, a declared release
  // places the item; no timestamp is consulted. Greptile flagged that counting
  // such items as "inferred" seeds a late-close hunt with items whose placement
  // was never in question.
  const report = explainChangelogSelection({
    items: [
      { id: "pm-pinned", title: "Pinned by declaration", status: "closed", type: "feature", release: "2026.7.24", closed_at: "2026-07-24T10:00:00Z" },
      { id: "pm-inferred", title: "Placed by closed_at", status: "closed", type: "feature", closed_at: "2026-07-24T11:00:00Z" },
      { id: "pm-authoritative", title: "Placed by completed_at", status: "closed", type: "feature", completed_at: "2026-07-24T12:00:00Z" },
    ],
    version: "2026.7.24",
    date: "2026-07-24",
    since: "2026-07-24T00:00:00Z",
    respectItemRelease: true,
  });
  const provenance = report.attribution_provenance;
  assert.ok(provenance);
  assert.equal(provenance.release_pinned, 1);
  assert.equal(provenance.inferred, 1);
  assert.equal(provenance.authoritative, 1);
  // The pinned item must not be offered as a late-close candidate.
  assert.deepEqual(provenance.inferred_sample, ["pm-inferred: Placed by closed_at"]);
  assert.equal(provenance.inferred_sources.closed_at, 1);
});

test("explainChangelogSelection counts a metadata-declared release as release-pinned", () => {
  // Greptile caught this: placement reads the declaration through
  // getStringField, which honours metadata.release as well as the top-level
  // field, so checking only item.release left a metadata-pinned item counted as
  // timestamp-attributed - the very skew the bucket removes.
  const report = explainChangelogSelection({
    items: [
      { id: "pm-meta-pinned", title: "Pinned via metadata", status: "closed", type: "feature", metadata: { release: "2026.7.24" }, closed_at: "2026-07-24T10:00:00Z" },
      { id: "pm-top-pinned", title: "Pinned via top level", status: "closed", type: "feature", release: "2026.7.24", closed_at: "2026-07-24T11:00:00Z" },
      { id: "pm-unpinned", title: "No declaration", status: "closed", type: "feature", closed_at: "2026-07-24T12:00:00Z" },
    ],
    version: "2026.7.24",
    date: "2026-07-24",
    since: "2026-07-24T00:00:00Z",
    respectItemRelease: true,
  });
  const provenance = report.attribution_provenance;
  assert.ok(provenance);
  assert.equal(provenance.release_pinned, 2);
  assert.equal(provenance.inferred, 1);
  assert.deepEqual(provenance.inferred_sample, ["pm-unpinned: No declaration"]);
});

test("explainChangelogSelection leaves release-pinned items in timestamp attribution when respectItemRelease is off", () => {
  // Without --respect-item-release the declaration is inert, so the same item is
  // genuinely placed by its timestamp and belongs in the inferred bucket.
  const report = explainChangelogSelection({
    items: [
      { id: "pm-pinned", title: "Declaration ignored", status: "closed", type: "feature", release: "2026.7.24", closed_at: "2026-07-24T10:00:00Z" },
    ],
    version: "2026.7.24",
    date: "2026-07-24",
    since: "2026-07-24T00:00:00Z",
  });
  const provenance = report.attribution_provenance;
  assert.ok(provenance);
  assert.equal(provenance.release_pinned, 0);
  assert.equal(provenance.inferred, 1);
  assert.equal(provenance.inferred_sources.closed_at, 1);
});

test("explainChangelogSelection orders the inferred sample newest-first", () => {
  // The documented contract is newest-first so the freshest late-close candidate
  // leads; encounter order would misstate it once the sample cap bites. The
  // items are supplied oldest-first to prove the order comes from the sort and
  // not from input order.
  const report = explainChangelogSelection({
    items: [
      { id: "pm-oldest", title: "Oldest", status: "closed", type: "feature", closed_at: "2026-07-20T10:00:00Z" },
      { id: "pm-middle", title: "Middle", status: "closed", type: "feature", closed_at: "2026-07-22T10:00:00Z" },
      { id: "pm-newest", title: "Newest", status: "closed", type: "feature", closed_at: "2026-07-24T10:00:00Z" },
    ],
    version: "2026.7.24",
    date: "2026-07-24",
    since: "2026-07-01T00:00:00Z",
  });
  const provenance = report.attribution_provenance;
  assert.ok(provenance);
  assert.equal(provenance.inferred, 3);
  assert.deepEqual(provenance.inferred_sample, [
    "pm-newest: Newest",
    "pm-middle: Middle",
    "pm-oldest: Oldest",
  ]);
});

test("explainChangelogSelection sorts undated inferred items last in the sample", () => {
  // An item with no completion, close, update or creation timestamp resolves to
  // no timestamp at all. It is the weakest late-close lead, so it must sort
  // behind every dated candidate rather than winning on encounter order. Such an
  // item only reaches the visible set when no time bound is applied - with a
  // `since` it is excluded by the time window before provenance runs.
  const report = explainChangelogSelection({
    items: [
      { id: "pm-undated", title: "Undated", status: "closed", type: "feature" },
      { id: "pm-dated", title: "Dated", status: "closed", type: "feature", closed_at: "2026-07-24T10:00:00Z" },
    ],
    version: "2026.7.24",
    date: "2026-07-24",
  });
  const provenance = report.attribution_provenance;
  assert.ok(provenance);
  assert.equal(provenance.inferred, 2);
  assert.deepEqual(provenance.inferred_sample, ["pm-dated: Dated", "pm-undated: Undated"]);
  // The undated item must not be credited to created_at, which supplied nothing.
  assert.equal(provenance.inferred_sources.none, 1);
  assert.equal(provenance.inferred_sources.created_at, undefined);
});

test("explainChangelogSelection reports a no-signal item as source none, not created_at", () => {
  // CodeRabbit caught resolveItemCompletion returning source "created_at" even
  // when created_at itself was absent, which credited a field that supplied no
  // value and inflated the created_at bucket with items carrying zero evidence
  // of when the work landed. An item with created_at present must still be
  // reported as created_at, so both branches are asserted here.
  const report = explainChangelogSelection({
    items: [
      { id: "pm-no-signal", title: "No timestamp at all", status: "closed", type: "feature" },
      { id: "pm-created-only", title: "Created only", status: "closed", type: "feature", created_at: "2026-07-24T09:00:00Z" },
    ],
    version: "2026.7.24",
    date: "2026-07-24",
  });
  const provenance = report.attribution_provenance;
  assert.ok(provenance);
  assert.equal(provenance.inferred, 2);
  assert.equal(provenance.inferred_sources.none, 1);
  assert.equal(provenance.inferred_sources.created_at, 1);
  // The dated created_at item leads; the no-signal item is the weakest lead.
  assert.deepEqual(provenance.inferred_sample, [
    "pm-created-only: Created only",
    "pm-no-signal: No timestamp at all",
  ]);
  // The hint names both fallback sources so the report stays actionable.
  assert.ok(
    report.hints.some((hint) => /inferred timestamp \(created_at,none\)/.test(hint)),
    `expected a hint naming both sources, got: ${JSON.stringify(report.hints)}`,
  );
});

test("explainChangelogSelection resolves items lacking updated_at without an SDK type assertion", () => {
  // The SDK's parameter type requires updated_at: string (upstream pm-cli#808),
  // so items without it are resolved by local precedence instead of a cast.
  // Both local branches must agree with the SDK's own ordering: completed_at is
  // authoritative, closed_at is an inferred fallback.
  const report = explainChangelogSelection({
    items: [
      { id: "pm-completed-no-updated", title: "Completed without updated", status: "closed", type: "feature", completed_at: "2026-07-24T10:00:00Z", closed_at: "2026-07-25T10:00:00Z" },
      { id: "pm-closed-no-updated", title: "Closed without updated", status: "closed", type: "feature", closed_at: "2026-07-23T10:00:00Z" },
    ],
    version: "2026.7.24",
    date: "2026-07-24",
  });
  const provenance = report.attribution_provenance;
  assert.ok(provenance);
  // completed_at wins over closed_at even on the local path, and stays authoritative.
  assert.equal(provenance.authoritative, 1);
  assert.equal(provenance.inferred, 1);
  assert.equal(provenance.inferred_sources.closed_at, 1);
  assert.deepEqual(provenance.inferred_sample, ["pm-closed-no-updated: Closed without updated"]);
});

test("explainChangelogSelection counts multi-window release pins as release-pinned", () => {
  // Greptile caught this: assignItemsToReleaseWindows (the --all-release-tags
  // path) buckets an item by a declaration matching a release-tag window and
  // consults no timestamp, but release_pinned was gated on attributionApplies,
  // which is false on that path. Declaration-placed items therefore still
  // counted as timestamp-attributed and could crowd the bounded sample — on the
  // path our own release workflows actually use.
  const report = explainChangelogSelection({
    items: [
      { id: "pm-pinned-tag", title: "Pinned to the tag window", status: "closed", type: "feature", release: "1.2.0", closed_at: "2026-05-01T12:00:00Z" },
      { id: "pm-pinned-meta", title: "Pinned via metadata", status: "closed", type: "feature", metadata: { release: "1.2.0" }, closed_at: "2026-05-02T12:00:00Z" },
      { id: "pm-by-time", title: "Placed by time only", status: "closed", type: "feature", closed_at: "2026-05-14T12:00:00Z" },
    ],
    releaseWindows: [
      { heading: "1.2.0 - 2026-05-17", releaseTag: "v1.2.0", since: "2026-05-10T13:00:00Z", sinceExclusive: true, until: "2026-05-17T13:00:00Z" },
      { heading: "1.1.0 - 2026-05-10", releaseTag: "v1.1.0", until: "2026-05-10T13:00:00Z" },
    ],
  });
  const provenance = report.attribution_provenance;
  assert.ok(provenance);
  // Both declaration forms are pins; only the timestamp-placed item is inferred.
  assert.equal(provenance.release_pinned, 2);
  assert.equal(provenance.inferred, 1);
  assert.deepEqual(provenance.inferred_sample, ["pm-by-time: Placed by time only"]);
});

test("explainChangelogSelection treats a release declaration matching no window as a timestamp attribution", () => {
  // A declaration that matches no release-tag window is not a pin: the item
  // falls through to time filtering, so counting it as release_pinned would
  // hide a genuine late-close candidate.
  const report = explainChangelogSelection({
    items: [
      { id: "pm-unmatched", title: "Declares an unknown release", status: "closed", type: "feature", release: "9.9.9", closed_at: "2026-05-14T12:00:00Z" },
    ],
    releaseWindows: [
      { heading: "1.2.0 - 2026-05-17", releaseTag: "v1.2.0", since: "2026-05-10T13:00:00Z", sinceExclusive: true, until: "2026-05-17T13:00:00Z" },
    ],
  });
  const provenance = report.attribution_provenance;
  assert.ok(provenance);
  assert.equal(provenance.release_pinned, 0);
  assert.equal(provenance.inferred, 1);
  assert.deepEqual(provenance.inferred_sample, ["pm-unmatched: Declares an unknown release"]);
});

// ---------------------------------------------------------------------------
// Issue 2 (Greptile on PR #174): suppressing a phantom pending release must
// not relocate an item into an older real release or drop it entirely. An
// item whose declared `release` names the SUPPRESSED pending version lands
// under `Unreleased`; every other unmatched declaration keeps its historical
// timestamp placement and attribution (the follow-up tests below).
// ---------------------------------------------------------------------------

/**
 * Release windows simulating `resolveReleaseTagWindowResolution` with
 * `pendingRelease: false` for a never-tagged placeholder version: the pending
 * window is gone, a leading `Unreleased` window owns post-tag work, and two
 * tagged releases follow. The same resolution reports `v2026.7.1` as the
 * suppressed pending release, which these tests forward through
 * `suppressedPendingRelease` exactly as the CLI and extension do.
 */
const SUPPRESSED_PENDING_WINDOWS = [
  { heading: "Unreleased", since: "2026-06-01T12:00:00Z", sinceExclusive: true },
  { heading: "2026.6.1 - 2026-06-01", releaseTag: "v2026.6.1", since: "2026-05-01T12:00:00Z", sinceExclusive: true, until: "2026-06-01T12:00:00Z" },
  { heading: "2026.5.1 - 2026-05-01", releaseTag: "v2026.5.1", until: "2026-05-01T12:00:00Z" },
] as const;

test("suppressed pending release does not relocate a declared item into an older real release", () => {
  // Shape: an item declares the suppressed placeholder version (2026.7.1) and
  // its completion timestamp falls squarely inside the 2026.6.1 window. Before
  // the fix the item was placed by time into `## 2026.6.1`, silently crediting
  // work to a real release that never shipped it. After the fix the item lands
  // under `## Unreleased` because its declared release is the one the caller
  // suppressed.
  const result = createChangelog({
    items: [
      {
        id: "pm-relocated",
        title: "Work attributed to a phantom release",
        status: "closed",
        type: "feature",
        release: "2026.7.1",
        completed_at: "2026-05-15T12:00:00Z",
      },
    ],
    releaseWindows: [...SUPPRESSED_PENDING_WINDOWS],
    suppressedPendingRelease: "v2026.7.1",
  });
  assert.match(result.markdown, /## Unreleased[\s\S]*pm-relocated/);
  assert.doesNotMatch(
    result.markdown.match(/## 2026\.6\.1[\s\S]*?(?=## 2026\.5\.1|$)/)?.[0] ?? "",
    /pm-relocated/,
  );
  assert.equal(result.itemCount, 1, "the item must not be dropped");
});

test("suppressed pending release does not drop a declared item narrowed out of an older release section", () => {
  // Shape: an item declares the suppressed placeholder version (2026.7.1) and
  // its completion timestamp falls inside the oldest tagged window (2026.5.1).
  // `--since-version 2026.6.1` narrows the visible sections to Unreleased +
  // 2026.6.1, dropping the 2026.5.1 section. Before the fix the item was placed
  // by time into `## 2026.5.1`, which was then dropped by section narrowing —
  // the item silently disappeared. After the fix it lands under `## Unreleased`
  // (which section narrowing always keeps), so it survives.
  const result = createChangelog({
    items: [
      {
        id: "pm-omitted",
        title: "Work that would have been lost",
        status: "closed",
        type: "bug",
        release: "2026.7.1",
        completed_at: "2026-04-15T12:00:00Z",
      },
    ],
    releaseWindows: [...SUPPRESSED_PENDING_WINDOWS],
    suppressedPendingRelease: "v2026.7.1",
    sinceVersion: "2026.6.1",
  });
  assert.match(result.markdown, /## Unreleased[\s\S]*pm-omitted/);
  assert.equal(result.itemCount, 1, "the item must not be dropped by section narrowing");
});

test("an item declaring the suppressed pending release lands under Unreleased whatever its timestamps say", () => {
  // The intended behaviour, now constrained to it: an item whose declared
  // release is the one the caller suppressed is routed to Unreleased
  // regardless of where its timestamps would place it — inside an older
  // window or outside all windows — alongside ordinary timestamp-placed work.
  const result = createChangelog({
    items: [
      {
        id: "pm-in-window",
        title: "Timestamp falls in an older release",
        status: "closed",
        type: "feature",
        release: "2026.7.1",
        completed_at: "2026-05-15T12:00:00Z",
      },
      {
        id: "pm-before-all",
        title: "Timestamp before the oldest tag",
        status: "closed",
        type: "bug",
        release: "2026.7.1",
        completed_at: "2026-04-01T12:00:00Z",
      },
      {
        id: "pm-ordinary",
        title: "Ordinary post-tag work",
        status: "closed",
        type: "task",
        completed_at: "2026-06-15T12:00:00Z",
      },
    ],
    releaseWindows: [...SUPPRESSED_PENDING_WINDOWS],
    suppressedPendingRelease: "v2026.7.1",
  });
  // Both declared items land under Unreleased alongside the ordinary item.
  const unreleasedSection = result.markdown.match(/## Unreleased[\s\S]*?(?=## 2026\.6\.1|$)/)?.[0] ?? "";
  assert.match(unreleasedSection, /pm-in-window/);
  assert.match(unreleasedSection, /pm-before-all/);
  assert.match(unreleasedSection, /pm-ordinary/);
  assert.equal(result.itemCount, 3, "all three items must appear");
});

test("explainChangelogSelection counts a suppressed-release declaration as release-pinned", () => {
  // Placement and provenance must agree: assignItemsToReleaseWindows routes a
  // declaration naming the suppressed pending release to Unreleased without
  // consulting a timestamp, so counting it as a timestamp attribution would
  // leak it out of the release_pinned bucket the way multi-window pins leaked
  // before (see the release-pinned counting test above).
  const report = explainChangelogSelection({
    items: [
      {
        id: "pm-suppressed-declared",
        title: "Declares the suppressed placeholder",
        status: "closed",
        type: "feature",
        release: "2026.7.1",
        closed_at: "2026-05-15T12:00:00Z",
      },
      {
        id: "pm-by-time",
        title: "Placed by time only",
        status: "closed",
        type: "task",
        // `completed_at` (not `closed_at`) so the item is an authoritative
        // timestamp attribution — the clean control the release-pinned item is
        // contrasted against. `closed_at` would classify as inferred (a
        // tracker closed long after its fix shipped), which the assertion
        // `inferred: 0` deliberately excludes.
        completed_at: "2026-06-15T12:00:00Z",
      },
    ],
    releaseWindows: [...SUPPRESSED_PENDING_WINDOWS],
    suppressedPendingRelease: "v2026.7.1",
  });
  const provenance = report.attribution_provenance;
  assert.ok(provenance);
  assert.equal(provenance.release_pinned, 1);
  assert.equal(provenance.authoritative, 1);
  assert.equal(provenance.inferred, 0);
});

test("a stale or misspelled release declaration keeps its timestamp placement and attribution", () => {
  // Greptile issue on PR #174 (the over-correction): the orphan routing fired
  // on every --all-release-tags run, so an item with a stale or misspelled
  // release declaration was pulled out of the tagged release its timestamps
  // place it in and filed under Unreleased, while the provenance still
  // classified it as placed by timestamp. Only a declaration naming the
  // SUPPRESSED pending release is routed now; every other unmatched
  // declaration keeps the pre-PR timestamp placement and classification.
  const options = {
    items: [
      {
        id: "pm-stale",
        title: "Declares a release that was never tagged",
        status: "closed",
        type: "bug",
release: "2026.4.9",
        // `completed_at` (not `closed_at`) so the provenance classifies the
        // item as authoritative timestamp placement — the classification the
        // assertion `authoritative: 2` checks. `closed_at` would mark these
        // as inferred late-close candidates instead.
        completed_at: "2026-05-15T12:00:00Z",
      },
      {
        id: "pm-misspelled",
        title: "Misspells the release it shipped in",
        status: "closed",
        type: "feature",
        release: "2026.6.l",
        completed_at: "2026-05-20T12:00:00Z",
      },
    ],
    releaseWindows: [
      { heading: "Unreleased", since: "2026-06-01T12:00:00Z", sinceExclusive: true },
      { heading: "2026.6.1 - 2026-06-01", releaseTag: "v2026.6.1", since: "2026-05-01T12:00:00Z", sinceExclusive: true, until: "2026-06-01T12:00:00Z" },
      { heading: "2026.5.1 - 2026-05-01", releaseTag: "v2026.5.1", until: "2026-05-01T12:00:00Z" },
    ],
  };
  const result = createChangelog(options);
  // Both stay in the 2026.6.1 window their timestamps place them in — the
  // pre-PR placement — instead of being pulled into Unreleased.
  const window61 = result.markdown.match(/## 2026\.6\.1[\s\S]*?(?=## 2026\.5\.1|$)/)?.[0] ?? "";
  assert.match(window61, /pm-stale/);
  assert.match(window61, /pm-misspelled/);
  const unreleased = result.markdown.match(/## Unreleased[\s\S]*?(?=## 2026\.6\.1|$)/)?.[0] ?? "";
  assert.equal(unreleased, "", "no items belong under Unreleased in an ordinary tagged repository");
  // And the provenance classifies them by timestamp, not as declaration pins
  // — the classification the placement actually used.
  const report = explainChangelogSelection(options);
  assert.equal(report.attribution_provenance?.release_pinned, 0);
  assert.equal(report.attribution_provenance?.authoritative, 2);
});

test("a suppressed declaration keeps timestamp placement when no Unreleased window exists", () => {
  // `includeUnreleased: false` is an explicit opt-out with no Unreleased
  // window to route to: the suppressed declaration falls through to timestamp
  // placement exactly as before, preserving the caller's opt-out.
  const result = createChangelog({
    items: [
      {
        id: "pm-suppressed-no-unreleased",
        title: "Declares the suppressed version with no Unreleased window",
        status: "closed",
        type: "feature",
        release: "2026.7.1",
        closed_at: "2026-05-15T12:00:00Z",
      },
    ],
    releaseWindows: [
      { heading: "2026.6.1 - 2026-06-01", releaseTag: "v2026.6.1", since: "2026-05-01T12:00:00Z", sinceExclusive: true, until: "2026-06-01T12:00:00Z" },
      { heading: "2026.5.1 - 2026-05-01", releaseTag: "v2026.5.1", until: "2026-05-01T12:00:00Z" },
    ],
    suppressedPendingRelease: "v2026.7.1",
  });
  assert.match(result.markdown, /## 2026\.6\.1[\s\S]*pm-suppressed-no-unreleased/);
  assert.doesNotMatch(result.markdown, /## Unreleased/);
});

test("explainChangelogSelection counts a suppressed declaration as timestamp attribution when no Unreleased window exists", () => {
  // When includeUnreleased is false and pendingRelease is false, there is no
  // Unreleased window to route to: the suppressed declaration falls through to
  // timestamp placement. The provenance must classify it as timestamp
  // attribution, not release-pinned, so the --explain report does not hide it
  // from the diagnostics used to identify potentially misplaced work.
  const report = explainChangelogSelection({
    items: [
      {
        id: "pm-suppressed-no-unreleased",
        title: "Declares the suppressed version with no Unreleased window",
        status: "closed",
        type: "feature",
        release: "2026.7.1",
        closed_at: "2026-05-15T12:00:00Z",
      },
    ],
    releaseWindows: [
      { heading: "2026.6.1 - 2026-06-01", releaseTag: "v2026.6.1", since: "2026-05-01T12:00:00Z", sinceExclusive: true, until: "2026-06-01T12:00:00Z" },
      { heading: "2026.5.1 - 2026-05-01", releaseTag: "v2026.5.1", until: "2026-05-01T12:00:00Z" },
    ],
    suppressedPendingRelease: "v2026.7.1",
  });
  const provenance = report.attribution_provenance;
  assert.ok(provenance);
  assert.equal(provenance.release_pinned, 0);
  assert.equal(provenance.inferred, 1);
});

// ---------------------------------------------------------------------------
// Round 3, Greptile issue 1 (reported twice) on PR #174: an explicit
// suppression must survive into createChangelog. The resolver's empty list
// and an absent one are now distinct spellings, so the handover between
// resolveReleaseTagWindows and createChangelog keeps the suppression.
// ---------------------------------------------------------------------------

test("an explicitly empty suppressed window list renders no release heading through createChangelog", (t) => {
  // A library caller combining pendingRelease: false with
  // includeUnreleased: false in a zero-tag repository receives [] from the
  // resolver; createChangelog used to read that empty list as absent history
  // and substitute a dated section for the resolved placeholder version, so
  // the suppression was undone one call later. The deliberate-emptiness
  // capability is reachable only on purpose: the caller must forward the
  // `suppressedPendingRelease` tag the resolution form reports alongside the
  // empty window list, which asserts the suppressing intent. Without that
  // signal an accidentally empty list (zero tags, no suppression asserted)
  // falls back to the absent-history single-version section, so silent total
  // item loss is not reachable from any combination of public options.
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-empty-suppression-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "pm changelog test"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "pm-changelog@example.com"], { cwd: directory, encoding: "utf-8" });
  writeFileSync(join(directory, "work.txt"), "work\n", "utf-8");
  execFileSync("git", ["add", "work.txt"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "work"], { cwd: directory, encoding: "utf-8" });

  const options = {
    items: [{
      id: "pm-suppressed-placeholder",
      title: "Work done under a placeholder version",
      status: "closed",
      type: "feature",
      closed_at: "2026-08-15T09:00:00Z",
    }],
    version: "2026.9.1",
    date: "2026-09-01",
    // Even the opt-in empty-section rendering must not resurrect the heading.
    includeEmpty: true,
  };
  const resolution = resolveReleaseTagWindowResolution({
    cwd: directory,
    pendingVersion: "2026.9.1",
    pendingTimestamp: "2026-09-01T12:00:00Z",
    pendingRelease: false,
    includeUnreleased: false,
  });
  assert.equal(resolution.windows.length, 0, "the resolver honours the suppression");
  assert.equal(resolution.suppressedPendingRelease, "v2026.9.1");

  const result = createChangelog({
    ...options,
    releaseWindows: resolution.windows,
    suppressedPendingRelease: resolution.suppressedPendingRelease,
  });
  assert.equal(result.markdown, "# Changelog\n");
  assert.equal(result.itemCount, 0);
  assert.deepEqual(result.sections, []);

  // The selection report agrees with the render — window mode, nothing
  // visible — instead of reporting the single-version shape the empty list
  // used to fall back into.
  const report = explainChangelogSelection({
    ...options,
    releaseWindows: resolution.windows,
    suppressedPendingRelease: resolution.suppressedPendingRelease,
    respectItemRelease: true,
  });
  assert.equal(report.filters.release_windows, true);
  assert.equal(report.stage_counts.visible_items, 0);
});

test("resolveReleaseTagWindows carries deliberate empty suppression into createChangelog", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-library-suppression-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "pm changelog test"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "pm-changelog@example.com"], { cwd: directory, encoding: "utf-8" });
  writeFileSync(join(directory, "work.txt"), "work\n", "utf-8");
  execFileSync("git", ["add", "work.txt"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "work"], { cwd: directory, encoding: "utf-8" });

  const releaseWindows = resolveReleaseTagWindows({
    cwd: directory,
    pendingVersion: "2026.9.1",
    pendingTimestamp: "2026-09-01T12:00:00Z",
    pendingRelease: false,
    includeUnreleased: false,
  });
  assert.equal(releaseWindows.length, 0);

  const result = createChangelog({
    items: [{
      id: "pm-library-suppressed",
      title: "Work under an untagged placeholder",
      status: "closed",
      type: "feature",
    }],
    version: "2026.9.1",
    date: "2026-09-01",
    releaseWindows,
  });
  assert.equal(result.markdown, "# Changelog\n");
  assert.equal(result.itemCount, 0);
  assert.deepEqual(result.sections, []);
});

test("an accidentally empty releaseWindows list preserves items under Unreleased", () => {
  // Regression test for the silent data-loss path introduced by PR #174:
  // resolveReleaseTagWindows returns [] in a zero-tag repository, and a
  // library caller that pipes one straight into the other —
  //   createChangelog({ items, releaseWindows: resolveReleaseTagWindows(...) })
  // — used to get a title-only changelog with every item silently dropped
  // because the empty list was read as deliberate emptiness. The fix makes
  // deliberate emptiness reachable only when the caller also asserts the
  // suppressing intent (suppressedPendingRelease); without that signal the
  // empty list is absent history, so items are preserved under ## Unreleased
  // exactly as origin/main does.
  const oneClosedItem: PmItem = {
    id: "pm-accidental-empty",
    title: "A fixed thing",
    status: "closed",
    type: "bug",
    closed_at: "2026-08-15T09:00:00Z",
  };

  // No suppressedPendingRelease: this is the accidental-empty shape.
  const result = createChangelog({ items: [oneClosedItem], releaseWindows: [] });
  assert.equal(result.itemCount, 1);
  assert.match(result.markdown, /^# Changelog\n\n## Unreleased\n/m);
  assert.match(result.markdown, /pm-accidental-empty/);

  // The selection report must NOT report window mode for an accidental empty.
  const report = explainChangelogSelection({ items: [oneClosedItem], releaseWindows: [] });
  assert.equal(report.filters.release_windows, false);
  assert.equal(report.stage_counts.visible_items, 1);

  // Contrast: with the suppressing intent asserted, the same empty list is
  // deliberate emptiness and emits nothing.
  const suppressed = createChangelog({
    items: [oneClosedItem],
    releaseWindows: [],
    suppressedPendingRelease: "v2026.9.1",
  });
  assert.equal(suppressed.markdown, "# Changelog\n");
  assert.equal(suppressed.itemCount, 0);
});

test("--no-pending-release routes items declaring the suppressed version to Unreleased in a tagged repository", (t) => {
  // End-to-end proof that the CLI forwards what the resolver suppressed: the
  // generator re-routes ONLY declarations naming the suppressed pending
  // release, so without the forwarding the declared item below would fall
  // back to timestamp placement and be credited to the older real release its
  // completion time falls inside. The stale declaration in the same run shows
  // the constrained half of the behaviour.
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-suppressed-forwarding-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "pm changelog test"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "pm-changelog@example.com"], { cwd: directory, encoding: "utf-8" });
  const commit = (message: string, date: string): void => {
    writeFileSync(join(directory, "file.txt"), `${message}\n`, "utf-8");
    execFileSync("git", ["add", "file.txt"], { cwd: directory, encoding: "utf-8" });
    execFileSync("git", ["commit", "-m", message], {
      cwd: directory,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    });
  };
  commit("one", "2026-05-01T12:00:00Z");
  execFileSync("git", ["tag", "v2026.5.1"], { cwd: directory, encoding: "utf-8" });
  commit("two", "2026-06-01T12:00:00Z");
  execFileSync("git", ["tag", "v2026.6.1"], { cwd: directory, encoding: "utf-8" });
  // Placeholder version that has never been tagged.
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "pm-suppression-fixture", version: "2026.7.1" }),
    "utf-8",
  );

  const input = join(directory, "items.json");
  writeFileSync(input, JSON.stringify([
    {
      id: "pm-declares-placeholder",
      title: "Declares the suppressed placeholder version",
      status: "closed",
      type: "feature",
      release: "2026.7.1",
      closed_at: "2026-05-15T12:00:00Z",
    },
    {
      id: "pm-stale-declaration",
      title: "Declares a release that was never tagged",
      status: "closed",
      type: "bug",
      release: "2026.4.9",
      closed_at: "2026-05-20T12:00:00Z",
    },
  ]), "utf-8");
  const cli = join(process.cwd(), "src", "cli.ts");
  const generate = (extra: string[]): string => execFileSync(process.execPath, [
    cli,
    "--input", input,
    "--stdout",
    "--all-release-tags",
    "--release-version-from-package",
    "--date-from-version",
    ...extra,
  ], {
    cwd: directory,
    encoding: "utf-8",
    env: { ...process.env, TZ: "UTC" },
  });

  // With the flag: the declared placeholder item lands under Unreleased
  // (not 2026.6.1), while the stale declaration keeps its timestamp placement
  // — the constrained routing, both halves in one run.
  const suppressed = generate(["--no-pending-release"]);
  const unreleasedSection = suppressed.match(/## Unreleased[\s\S]*?(?=## 2026\.6\.1|$)/)?.[0] ?? "";
  const window61 = suppressed.match(/## 2026\.6\.1[\s\S]*?(?=## 2026\.5\.1|$)/)?.[0] ?? "";
  assert.match(unreleasedSection, /pm-declares-placeholder/);
  assert.doesNotMatch(window61, /pm-declares-placeholder/);
  assert.match(window61, /pm-stale-declaration/);
  assert.doesNotMatch(unreleasedSection, /pm-stale-declaration/);

  // Default behaviour is unchanged: the pending window leads and the
  // declaration pins the item into it.
  const cutting = generate([]);
  assert.match(cutting, /## 2026\.7\.1 - 2026-07-01[\s\S]*pm-declares-placeholder/);
});

test("--all-release-tags with zero tags and no version keeps the Unreleased fallback", (t) => {
  // A repository before its first release has no tags and nothing to resolve
  // a version from: the resolver's empty list is absent history, and the CLI
  // deliberately spells it as undefined so the generator keeps the
  // single-section `## Unreleased` fallback. Passing the empty list through
  // unchanged would render a title-only changelog and drop all the work —
  // the exact regression the empty/absent distinction makes possible.
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-zero-tag-fallback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "pm changelog test"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "pm-changelog@example.com"], { cwd: directory, encoding: "utf-8" });
  writeFileSync(join(directory, "work.txt"), "work\n", "utf-8");
  execFileSync("git", ["add", "work.txt"], { cwd: directory, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "work"], {
    cwd: directory,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-01T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-01T12:00:00Z",
    },
  });

  const input = join(directory, "items.json");
  writeFileSync(input, JSON.stringify([{
    id: "pm-pre-first-release",
    title: "Work before the first release",
    status: "closed",
    type: "feature",
    closed_at: "2026-08-15T09:00:00Z",
  }]), "utf-8");
  const cli = join(process.cwd(), "src", "cli.ts");
  const output = execFileSync(process.execPath, [
    cli,
    "--input", input,
    "--stdout",
    "--all-release-tags",
  ], {
    cwd: directory,
    encoding: "utf-8",
    env: { ...process.env, TZ: "UTC" },
  });
  assert.match(output, /^# Changelog\n\n## Unreleased\n/m);
  assert.match(output, /pm-pre-first-release/);
});
