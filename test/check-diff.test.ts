import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createUnifiedDiff, DEFAULT_MAX_DIFF_LINES } from "../src/diff.ts";

// End-to-end tests for the `--check` drift diff. The CLI is driven with a
// fixed pm JSON fixture via --input (no `pm` or git needed), so the generated
// side is fully deterministic; the committed side is a file we write by hand.
// All assertions are on captured stdout/stderr, so this is the exact surface
// a CI gate sees.

const CLI = join(process.cwd(), "src", "cli.ts");

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

test("a truncated wholesale replacement still shows both deletions and insertions", () => {
  // Regression: a flat prefix cut of the diff body emitted every "-" line
  // before any "+" line, so capping a fully regenerated changelog — the most
  // common drift shape — showed only what was removed and nothing the
  // generator produced, which is exactly what --check is asked to report.
  const oldText = Array.from({ length: 300 }, (_, i) => `OLD line ${i}`).join("\n") + "\n";
  const newText = Array.from({ length: 300 }, (_, i) => `NEW line ${i}`).join("\n") + "\n";
  const result = createUnifiedDiff(oldText, newText, { maxLines: 200, oldLabel: "old", newLabel: "new" });

  assert.equal(result.truncated, true);
  const body = result.text.split("\n").filter(Boolean).slice(2); // drop --- / +++
  const deletions = body.filter((line) => line.startsWith("-"));
  const insertions = body.filter((line) => line.startsWith("+"));

  assert.ok(deletions.length > 0, "truncated diff must still show deletions");
  assert.ok(insertions.length > 0, "truncated diff must still show insertions");
  assert.ok(body.length <= 200, `emitted body (${body.length}) must respect the 200-line cap`);
});

test("truncation does not starve a side that is legitimately empty", () => {
  // A pure insertion has no deletions to show; balancing must not fabricate
  // one or waste budget reserving room for it.
  const oldText = "keep\n";
  const newText = "keep\n" + Array.from({ length: 400 }, (_, i) => `added ${i}`).join("\n") + "\n";
  const result = createUnifiedDiff(oldText, newText, { maxLines: 200, oldLabel: "old", newLabel: "new" });

  const body = result.text.split("\n").filter(Boolean).slice(2);
  assert.equal(result.truncated, true);
  assert.equal(body.filter((line) => line.startsWith("-")).length, 0);
  assert.ok(body.filter((line) => line.startsWith("+")).length > 150, "insertions must fill the budget");
});

test("help documents --no-check-diff and the --check diff behavior", () => {
  const out = execFileSync(process.execPath, [CLI, "--help"], { encoding: "utf-8" });
  assert.match(out, /--no-check-diff/);
  assert.match(out, /unified diff/);
});
// --- branch coverage of the diff engine internals ---------------------------

test("createUnifiedDiff falls back to a block replace for inputs beyond the LCS cell budget", () => {
  // Two disjoint inputs of ~2100 lines exceed MAX_LCS_CELLS (4_000_000), so the
  // quadratic table is skipped and the middle degrades to all-deletes-then-all-
  // inserts. The line cap keeps the rendered output bounded either way.
  const oldText = Array.from({ length: 2100 }, (_, i) => `o${i}`).join("\n") + "\n";
  const newText = Array.from({ length: 2100 }, (_, i) => `n${i}`).join("\n") + "\n";
  const result = createUnifiedDiff(oldText, newText, { maxLines: 200 });
  assert.equal(result.truncated, true);
  assert.match(result.text, /^--- old\n\+\+\+ new\n/);
  // The fallback emits deletions first; the cap preserves both sides.
  const body = result.text.split("\n").filter(Boolean).slice(2);
  assert.ok(body.some((line) => line.startsWith("-")), "fallback must still show deletions");
  assert.ok(body.some((line) => line.startsWith("+")), "fallback must still show insertions");
});

test("createUnifiedDiff uses default labels when none are given", () => {
  const result = createUnifiedDiff("a\n", "b\n");
  assert.match(result.text, /^--- old\n\+\+\+ new\n/);
});

test("createUnifiedDiff emits a trailing-deletion tail after a shared prefix", () => {
  // old is longer than new with a shared head: the LCS trace leaves old-only
  // lines after the shared prefix, exercising the trailing-deletes loop.
  const result = createUnifiedDiff("keep\ndrop1\ndrop2\n", "keep\n");
  const body = result.text.split("\n").filter(Boolean).slice(2);
  assert.ok(body.some((line) => line === "-drop1"));
  assert.ok(body.some((line) => line === "-drop2"));
});

test("createUnifiedDiff splits far-apart changes into separate hunks", () => {
  // Two single-line edits separated by many unchanged lines exceed the context
  // window, so buildHunks pushes the first span and starts a second hunk.
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const oldText = lines.join("\n") + "\n";
  const newText = lines.map((line, i) => (i === 2 ? "CHANGED-A" : i === 37 ? "CHANGED-B" : line)).join("\n") + "\n";
  const result = createUnifiedDiff(oldText, newText, { maxLines: 200 });
  const headers = result.text.split("\n").filter((line) => line.startsWith("@@"));
  assert.ok(headers.length >= 2, "far-apart changes must split into multiple hunks");
});

test("a pure-deletion hunk reports a newStart with no +1 offset", () => {
  // Removing every line against an empty new side yields a hunk whose newCount
  // is 0, so the newStart ternary takes its `newBefore[start]` (no +1) arm.
  const result = createUnifiedDiff("gone1\ngone2\n", "", { maxLines: 200 });
  const body = result.text.split("\n").filter(Boolean).slice(2);
  assert.ok(body.some((line) => line === "-gone1"));
  assert.ok(body.some((line) => line === "-gone2"));
  // The hunk header carries the +0,0 range for a pure-deletion hunk.
  assert.match(result.text, /\+0,0 @@/);
});

test("createUnifiedDiff caps a multi-hunk diff and stops emitting whole hunks", () => {
  // Changes spaced far apart (well beyond twice the context window) split into
  // separate hunks; a tiny budget exhausts the cap on the first hunk, so the
  // hunk loop breaks at the top of the next iteration rather than emitting
  // further headers.
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
  const oldText = lines.join("\n") + "\n";
  const newText = lines.map((line, i) => (i === 5 ? "EDIT-A" : i === 45 ? "EDIT-B" : line)).join("\n") + "\n";
  const result = createUnifiedDiff(oldText, newText, { maxLines: 4 });
  assert.equal(result.truncated, true);
  assert.ok(result.omittedLines > 0);
  const body = result.text.split("\n").filter(Boolean).slice(2);
  assert.ok(body.length <= 4, `emitted body (${body.length}) must respect the 4-line cap`);
});

test("createUnifiedDiff shares a common suffix across edits", () => {
  // A shared tail that the prefix scan cannot reach is captured by the suffix
  // loop, so a middle edit keeps trailing context intact.
  const oldText = "head\nMIDDLE\nfoot\n";
  const newText = "head\nchanged\nfoot\n";
  const result = createUnifiedDiff(oldText, newText, { maxLines: 200 });
  const body = result.text.split("\n").filter(Boolean).slice(2);
  assert.ok(body.some((line) => line === " foot"), "shared suffix must render as context");
  assert.ok(body.some((line) => line === "-MIDDLE"));
  assert.ok(body.some((line) => line === "+changed"));
});
