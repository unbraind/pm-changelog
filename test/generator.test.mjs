import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createChangelog, mergeChangelog, writeChangelog } from "../dist/index.js";

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
