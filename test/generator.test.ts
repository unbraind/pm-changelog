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

test("createChangelog preserves empty release windows", () => {
  const result = createChangelog({
    items: [],
    releaseWindows: [
      { heading: "Unreleased", since: "2026-05-18T12:00:00Z", sinceExclusive: true },
      { heading: "1.2.0 - 2026-05-17", until: "2026-05-17T12:00:00Z" },
    ],
  });

  assert.equal(result.itemCount, 0);
  assert.match(result.markdown, /## Unreleased\n\nNo changes\./);
  assert.match(result.markdown, /## 1\.2\.0 - 2026-05-17\n\nNo changes\./);
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
    pendingTimestamp: "2026-05-20T12:00:00Z",
  });

  assert.equal(windows.length, 4);
  assert.equal(windows[0].heading, "Unreleased");
  assert.equal(windows[0].since, "2026-05-20T12:00:00.000Z");
  assert.equal(windows[1].heading, "1.3.0 - 2026-05-20");
  assert.equal(windows[1].since, "2026-05-17T12:00:00Z");
  assert.equal(windows[1].until, "2026-05-20T12:00:00.000Z");
  assert.equal(windows[2].heading, "1.2.0 - 2026-05-17");
  assert.equal(windows[2].since, "2026-05-10T12:00:00Z");
  assert.equal(windows[2].until, "2026-05-17T12:00:00Z");
  assert.equal(windows[3].heading, "1.1.0 - 2026-05-10");
  assert.ok(windows.every((window) => !window.heading.startsWith("9.9.9")));
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

  assert.match(stdout, /## 1\.2\.0/);
  assert.match(stdout, /Current release item/);
  assert.doesNotMatch(stdout, /Old release item|Post-release item|## Unreleased/);
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

  assert.match(stdout, /## 2026\.5\.24-12/);
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

  execFileSync(pmBin, ["init", "--json"], {
    cwd: dir,
    encoding: "utf-8",
  });
  execFileSync(pmBin, ["install", process.cwd(), "--project", "--json"], {
    cwd: dir,
    encoding: "utf-8",
  });

  const doctor = JSON.parse(execFileSync(pmBin, ["package", "doctor", "--project", "--json", "--detail", "deep"], {
    cwd: dir,
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
        encoding: "utf-8",
      }
    ),
    /Command \\"changelog generate\\" failed/
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
