import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createChangelog,
  mergeChangelog,
  readPmItems,
  resolveReleaseTagWindows,
  writeChangelog,
} from "../dist/index.js";

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

  assert.equal(windows.length, 4);
  assert.equal(windows[0].heading, "Unreleased");
  assert.equal(windows[0].since, "2026-05-20T12:00:00.000Z");
  assert.equal(windows[1].heading, "1.3.0 - 2026-05-20");
  // Window `since`/`until` are normalized to ISO `Z` form in the source
  // (resolveReleaseTagWindows), so they're stable regardless of the git
  // version that produced the tag's %(committerdate:iso-strict) output
  // (older git: `...T12:00:00Z`; git >= ~2.42: `...T12:00:00+00:00`).
  assert.equal(windows[1].since, "2026-05-17T12:00:00.000Z");
  assert.equal(windows[1].until, "2026-05-20T12:00:00.000Z");
  assert.equal(windows[2].heading, "1.2.0 - 2026-05-17");
  assert.equal(windows[2].since, "2026-05-10T12:00:00.000Z");
  assert.equal(windows[2].until, "2026-05-17T12:00:00.000Z");
  assert.equal(windows[3].heading, "1.1.0 - 2026-05-10");
  assert.ok(windows.every((window) => !window.heading.startsWith("9.9.9")));
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

  assert.equal(windows.length, 3);
  assert.equal(windows[0].heading, "Unreleased");
  // The pending heading must echo the caller's unpadded YYYY.M.D version so the
  // pm-cli release pipeline can locate the `## 2026.5.27` section it asked for.
  assert.equal(windows[1].heading, "2026.5.27 - 2026-05-27");
  assert.doesNotMatch(windows[1].heading, /2026\.05\.27/);
  // Padded calendar tags render unpadded headings too, so the post-tag heading
  // matches the pre-tag pending heading and the committed CHANGELOG (issue #41).
  assert.equal(windows[2].heading, "2026.5.24 - 2026-05-24");
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
      "dist/cli.js",
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
      "dist/cli.js",
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
      "dist/cli.js",
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
  const cli = join(process.cwd(), "dist", "cli.js");
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
  const cli = join(process.cwd(), "dist", "cli.js");
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

test("CLI derives release heading date from explicit version tag", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-explicit-version-date-"));
  const input = join(dir, "items.json");
  const cli = join(process.cwd(), "dist", "cli.js");
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
  const cli = join(process.cwd(), "dist", "cli.js");
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

test("readPmItems supports runner wrappers with custom binaries, args, cwd, and env", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const fixture = join(dir, "fixture.json");
  const wrapper = join(dir, "pm-wrapper.mjs");
  writeFileSync(fixture, JSON.stringify(items), "utf-8");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

if (process.argv.slice(2).join(" ") !== "--profile ci list-all --json") process.exit(2);
if (process.env.PM_CHANGELOG_TEST !== "1") process.exit(3);
process.stdout.write(readFileSync(resolve(process.cwd(), "fixture.json"), "utf-8"));
`,
    "utf-8"
  );
  chmodSync(wrapper, 0o755);

  const result = readPmItems({
    pmBin: wrapper,
    pmArgs: ["--profile", "ci"],
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
if (process.argv.slice(2).join(" ") !== "list-all --json") process.exit(2);
process.stdout.write(JSON.stringify({ items: [{ id: "pm-large", title: "Large tracker", status: "closed", body: ${JSON.stringify(largeBody)} }] }));
`,
    "utf-8"
  );
  chmodSync(wrapper, 0o755);

  const result = readPmItems({ pmBin: wrapper });

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "pm-large");
});

test("CLI can run a custom pm binary", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const wrapper = join(dir, "pm-wrapper.mjs");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
if (process.argv.slice(2).join(" ") !== "list-all --json") process.exit(2);
process.stdout.write(${JSON.stringify(JSON.stringify(items))});
`,
    "utf-8"
  );
  chmodSync(wrapper, 0o755);

  const stdout = execFileSync(
    process.execPath,
    [
      "dist/cli.js",
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
  writeFileSync(fixture, JSON.stringify(items), "utf-8");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

if (process.argv.slice(2).join(" ") !== "--profile ci --workspace release list-all --json") process.exit(2);
if (!existsSync(resolve(process.cwd(), "fixture.json"))) process.exit(3);
process.stdout.write(readFileSync(resolve(process.cwd(), "fixture.json"), "utf-8"));
`,
    "utf-8"
  );
  chmodSync(wrapper, 0o755);

  const stdout = execFileSync(
    process.execPath,
    [
      "dist/cli.js",
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

test("pm package install activates changelog command", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-install-"));
  const pmBin = join(process.cwd(), "node_modules", ".bin", "pm");
  const pmEnv = { ...process.env, PM_GLOBAL_PATH: join(dir, "global-pm") };

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

  const doctor = JSON.parse(execFileSync(pmBin, ["package", "doctor", "--project", "--json", "--detail", "deep"], {
    cwd: dir,
    env: pmEnv,
    encoding: "utf-8",
  }));
  assert.deepEqual(doctor.warnings, []);
  assert.equal(doctor.details.summary.activation_status_totals.ok, 1);

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
  assert.ok(generated.item_count >= 1);
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

  execFileSync(pmBin, ["init", "--json"], {
    cwd: dir,
    encoding: "utf-8",
  });
  execFileSync(pmBin, ["install", process.cwd(), "--project", "--json"], {
    cwd: dir,
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
      "--title",
      "Generate changelog without global pm",
      "--description",
      "Verify extension can use the current node cli entrypoint",
      "--status",
      "closed",
      "--json",
    ],
    {
      cwd: dir,
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
      env: { ...process.env, PATH: dirname(process.execPath) },
    }
  ));

  assert.equal(generated.changed, true);
  assert.ok(generated.item_count >= 1);
  const markdown = readFileSync(join(dir, "CHANGELOG.md"), "utf-8");
  assert.match(markdown, /## node-cli - 2026-05-17/);
  assert.match(markdown, /Generate changelog without global pm/);
  assert.match(markdown, /\[pmc?-[a-z0-9]+\]\(https:\/\/example\.com\/pm\/tasks\/pmc?-[a-z0-9]+\.toon\)/);
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

test("createChangelog: command-name keywords (update/change) in Issue titles still route to Fixed", () => {
  // Regression: an Issue titled after the `pm update` command matched the weak
  // "update" needle in the Changed bucket and was misfiled under Changed. A
  // bug-like item *type* must win over those command-name-colliding keywords.
  const commandNameIssues = [
    { id: "pm-u", title: "pm update doesn't accept --expected/--actual aliases that pm close accepts", type: "Issue" },
    { id: "pm-c", title: "pm update change is not applied to nested items", type: "Issue" },
  ].map((entry) => ({
    ...entry,
    status: "closed",
    release: "1.2.0",
    updated_at: "2026-05-28T09:00:00Z",
  }));
  const result = createChangelog({ items: commandNameIssues, version: "1.2.0", date: "2026-05-28" });
  assert.match(result.markdown, /### Fixed/);
  assert.match(result.markdown, /- pm update doesn't accept/);
  assert.match(result.markdown, /- pm update change is not applied/);
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
