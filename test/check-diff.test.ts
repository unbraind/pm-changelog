import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createUnifiedDiff, DEFAULT_MAX_DIFF_LINES } from "../dist/diff.js";

// End-to-end tests for the `--check` drift diff. The CLI is driven with a
// fixed pm JSON fixture via --input (no `pm` or git needed), so the generated
// side is fully deterministic; the committed side is a file we write by hand.
// All assertions are on captured stdout/stderr, so this is the exact surface
// a CI gate sees.

const CLI = join(process.cwd(), "dist", "cli.js");

const FIXTURE = {
  items: [
    { id: "pm-feat", title: "Add dark mode toggle", status: "closed", type: "Feature", tags: ["feature"], assignee: "alice", updated_at: "2026-05-28T09:00:00Z" },
    { id: "pm-bug", title: "Crash on empty input", status: "closed", type: "Issue", tags: ["bug"], assignee: "bob", updated_at: "2026-05-28T08:00:00Z" },
    { id: "pm-chore", title: "Update build dependencies", status: "closed", type: "Task", tags: ["chore"], assignee: "alice", updated_at: "2026-05-28T07:00:00Z" },
  ],
};

// The exact markdown `--input FIXTURE --version 1.2.0 --date 2026-05-28` emits.
const GENERATED = `# Changelog

## 1.2.0 - 2026-05-28

### Added

- Add dark mode toggle (pm-feat)

### Changed

- Update build dependencies (pm-chore)

### Fixed

- Crash on empty input (pm-bug)
`;

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-chkdiff-"));
  const path = join(dir, "items.json");
  writeFileSync(path, JSON.stringify(FIXTURE), "utf-8");
  return path;
}

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf-8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function baseArgs(input: string, output: string): string[] {
  return ["--input", input, "--version", "1.2.0", "--date", "2026-05-28", "--output", output];
}

test("check drift prints a unified diff to stderr naming the actually-differing lines", () => {
  const input = writeFixture();
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-chkdiff-out-"));
  const out = join(dir, "CHANGELOG.md");
  // A committed changelog missing the Fixed section -> the diff must name it.
  const stale = `# Changelog

## 1.2.0 - 2026-05-28

### Added

- Add dark mode toggle (pm-feat)

### Changed

- Update build dependencies (pm-chore)
`;
  writeFileSync(out, stale, "utf-8");

  const result = runCli([...baseArgs(input, out), "--check"]);

  assert.equal(result.status, 1, "drift must exit 1");
  // The existing line is preserved verbatim and comes first.
  assert.match(result.stderr, /^Changelog is out of date: .*CHANGELOG\.md\n/);
  // Sides are labeled unambiguously.
  assert.match(result.stderr, /--- committed CHANGELOG\.md\n/);
  assert.match(result.stderr, /\+\+\+ generated\n/);
  // The diff names the actually-missing entry (a `+` insert of the Fixed
  // line): the diff prefix `+` is followed by the markdown bullet `- `.
  assert.match(result.stderr, /^\+- Crash on empty input \(pm-bug\)$/m);
  assert.match(result.stderr, /^\+### Fixed$/m);
  // Hunk header present.
  assert.match(result.stderr, /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@$/m);
});

test("an up-to-date changelog prints NO diff and still exits 0", () => {
  const input = writeFixture();
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-chkdiff-clean-"));
  const out = join(dir, "CHANGELOG.md");
  // Write the exact generated content so there is no drift.
  writeFileSync(out, GENERATED, "utf-8");

  const result = runCli([...baseArgs(input, out), "--check"]);

  assert.equal(result.status, 0, "up-to-date must exit 0");
  assert.match(result.stderr, /^Changelog is up to date: .*CHANGELOG\.md\n/);
  assert.doesNotMatch(result.stderr, /^--- committed/m);
  assert.doesNotMatch(result.stderr, /^\+\+\+ generated/m);
  assert.doesNotMatch(result.stderr, /^@@/m);
});

test("--no-check-diff suppresses the diff but preserves the exit code", () => {
  const input = writeFixture();
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-chkdiff-nodiff-"));
  const out = join(dir, "CHANGELOG.md");
  const stale = `# Changelog\n\n## 1.2.0 - 2026-05-28\n\n### Added\n\n- Add dark mode toggle (pm-feat)\n`;
  writeFileSync(out, stale, "utf-8");

  const result = runCli([...baseArgs(input, out), "--check", "--no-check-diff"]);

  assert.equal(result.status, 1, "exit code must stay 1 under --no-check-diff");
  // The existing failure line is still there.
  assert.match(result.stderr, /^Changelog is out of date: .*CHANGELOG\.md\n/);
  // No diff artifacts at all.
  assert.doesNotMatch(result.stderr, /^--- committed/m);
  assert.doesNotMatch(result.stderr, /^\+\+\+ generated/m);
  assert.doesNotMatch(result.stderr, /^@@/m);
  assert.doesNotMatch(result.stderr, /diff truncated/);
});

test("the diff goes to stderr, so a caller capturing stdout is unaffected", () => {
  const input = writeFixture();
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-chkdiff-stdout-"));
  const out = join(dir, "CHANGELOG.md");
  const stale = `# Changelog\n\n## 1.2.0 - 2026-05-28\n`;
  writeFileSync(out, stale, "utf-8");

  const result = runCli([...baseArgs(input, out), "--check"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "", "stdout must be empty so stdout-capturing callers are unaffected");
  assert.match(result.stderr, /--- committed CHANGELOG\.md/);
});

test("truncation triggers past the cap and states the omitted-line count", () => {
  const input = writeFixture();
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-chkdiff-trunc-"));
  const out = join(dir, "CHANGELOG.md");
  // A committed file with far more lines than the cap (300 disjoint lines) so
  // the diff (all deletes + a few inserts) exceeds the 200-line cap.
  const stale = Array.from({ length: 300 }, (_, i) => `stale line ${i}`).join("\n") + "\n";
  writeFileSync(out, stale, "utf-8");

  const result = runCli([...baseArgs(input, out), "--check"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /diff truncated: \d+ more lines not shown/);
  assert.match(result.stderr, new RegExp(`${DEFAULT_MAX_DIFF_LINES}-line cap`));
  assert.match(result.stderr, /Regenerate locally/);
  // The truncated diff body must not exceed the cap (the two file headers are
  // outside the cap; count only the lines after them).
  const diffStart = result.stderr.indexOf("--- committed CHANGELOG.md");
  assert.ok(diffStart >= 0, "diff header must be present");
  const diffBlock = result.stderr.slice(diffStart);
  // Stop at the truncation notice when counting emitted hunk lines.
  const noticeIndex = diffBlock.indexOf("... diff truncated");
  const diffBody = noticeIndex >= 0 ? diffBlock.slice(0, noticeIndex) : diffBlock;
  const hunkLineCount = diffBody.split("\n").length - 1; // drop the trailing "" from the final newline
  assert.ok(
    hunkLineCount <= DEFAULT_MAX_DIFF_LINES + 2, // +2 for the --- / +++ headers
    `emitted diff body (${hunkLineCount} lines) must respect the ${DEFAULT_MAX_DIFF_LINES}-line cap`
  );
});

test("--no-check-diff is a known option (no unknown-option error)", () => {
  const input = writeFixture();
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-chkdiff-known-"));
  const out = join(dir, "CHANGELOG.md");
  writeFileSync(out, GENERATED, "utf-8");

  const result = runCli([...baseArgs(input, out), "--check", "--no-check-diff"]);

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /Unknown option/);
  assert.doesNotMatch(result.stderr, /Did you mean/);
});

// --- unit-level coverage of the diff renderer itself -------------------------

test("createUnifiedDiff emits nothing for identical inputs", () => {
  const result = createUnifiedDiff(GENERATED, GENERATED, {
    oldLabel: "committed CHANGELOG.md",
    newLabel: "generated",
  });
  assert.equal(result.text, "");
  assert.equal(result.truncated, false);
  assert.equal(result.omittedLines, 0);
});

test("createUnifiedDiff honors a small maxLines cap and reports the omitted count", () => {
  const oldText = Array.from({ length: 50 }, (_, i) => `old ${i}`).join("\n") + "\n";
  const newText = Array.from({ length: 50 }, (_, i) => `new ${i}`).join("\n") + "\n";
  const result = createUnifiedDiff(oldText, newText, { maxLines: 5, oldLabel: "old", newLabel: "new" });
  assert.equal(result.truncated, true);
  assert.ok(result.omittedLines > 0, "must report a positive omitted count");
  // The full diff would be 100 hunk lines (50 deletes + 50 inserts) plus one
  // @@ header; the cap keeps only 5 hunk lines.
  const body = result.text.split("\n").filter(Boolean).slice(2); // drop --- / +++
  assert.ok(body.length <= 5, `emitted body (${body.length}) must respect the 5-line cap`);
});

test("help documents --no-check-diff and the --check diff behavior", () => {
  const out = execFileSync(process.execPath, [CLI, "--help"], { encoding: "utf-8" });
  assert.match(out, /--no-check-diff/);
  assert.match(out, /unified diff/);
});