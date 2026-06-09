import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// End-to-end regression test for the public CLI. Feeds a fixed pm JSON via
// --input (so it needs neither `pm` nor git in CI) and asserts the rendered
// markdown is byte-identical to a recorded baseline when no opt-in flag is set.
// This is the same render path the release-workflow invocation drives.

const CLI = join(process.cwd(), "dist", "cli.js");

const FIXTURE = {
  items: [
    { id: "pm-feat", title: "Add dark mode toggle", status: "closed", type: "Feature", tags: ["feature"], assignee: "alice", updated_at: "2026-05-28T09:00:00Z" },
    { id: "pm-bug", title: "Crash on empty input", status: "closed", type: "Issue", tags: ["bug"], assignee: "bob", updated_at: "2026-05-28T08:00:00Z" },
    { id: "pm-chore", title: "Update build dependencies", status: "closed", type: "Task", tags: ["chore"], assignee: "alice", updated_at: "2026-05-28T07:00:00Z" },
    { id: "pm-open", title: "Future work", status: "open", type: "Task", updated_at: "2026-05-28T06:00:00Z" },
  ],
};

// Recorded baseline for: --input <fixture> --release-version 1.2.0 --date 2026-05-28 --stdout
// (default grouping, no opt-in flags). If this string ever needs to change, it
// means default output changed — which would break every sibling package.
const BASELINE = `# Changelog

## 1.2.0 - 2026-05-28

### Added

- Add dark mode toggle (pm-feat)

### Changed

- Update build dependencies (pm-chore)

### Fixed

- Crash on empty input (pm-bug)
`;

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-cli-"));
  const path = join(dir, "items.json");
  writeFileSync(path, JSON.stringify(FIXTURE), "utf-8");
  return path;
}

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf-8" });
}

function runCliDetailed(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf-8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("CLI default render is byte-identical to the recorded baseline", () => {
  const input = writeFixture();
  const out = runCli(["--input", input, "--version", "1.2.0", "--date", "2026-05-28", "--stdout"]);
  assert.equal(out, BASELINE);
});

test("CLI opt-in flags only change output when present", () => {
  const input = writeFixture();
  const baseArgs = ["--input", input, "--version", "1.2.0", "--date", "2026-05-28", "--stdout"];
  // Passing the new flags at their default values must reproduce the baseline.
  const neutral = runCli([...baseArgs, "--section-by", "category"]);
  assert.equal(neutral, BASELINE);

  const conv = runCli([...baseArgs, "--conventional"]);
  assert.notEqual(conv, BASELINE);
  assert.match(conv, /### Features\n/);

  const contrib = runCli([...baseArgs, "--contributors"]);
  assert.match(contrib, /### Contributors\n\n@alice, @bob\n/);

  const byType = runCli([...baseArgs, "--section-by", "type"]);
  assert.match(byType, /### Feature\n/);
});

test("CLI accepts --flag=value syntax for value options", () => {
  const input = writeFixture();
  const out = runCli([
    "--input",
    input,
    "--version=1.2.0",
    "--date=2026-05-28",
    "--status=closed",
    "--stdout",
  ]);
  assert.equal(out, BASELINE);
});

test("CLI accepts --release-version as a compatibility alias for --version", () => {
  const input = writeFixture();
  const out = runCli([
    "--input",
    input,
    "--release-version=1.2.0",
    "--date=2026-05-28",
    "--stdout",
  ]);
  assert.equal(out, BASELINE);
});

test("CLI unknown option errors include a did-you-mean suggestion", () => {
  const input = writeFixture();
  const result = runCliDetailed([
    "--input",
    input,
    "--versoin=1.2.0",
    "--date=2026-05-28",
    "--stdout",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option: --versoin=1\.2\.0/);
  assert.match(result.stderr, /Did you mean '--version'\?/);
});

test("CLI --changelog-json emits a structured document", () => {
  const input = writeFixture();
  const out = runCli(["--input", input, "--version", "1.2.0", "--date", "2026-05-28", "--changelog-json"]);
  const doc = JSON.parse(out);
  assert.equal(doc.title, "Changelog");
  assert.equal(doc.section_by, "category");
  assert.equal(doc.item_count, 3);
  assert.equal(doc.releases[0].version, "1.2.0");
});

test("CLI --explain augments --json summaries with selection diagnostics", () => {
  const input = writeFixture();
  const out = runCli(["--input", input, "--version", "1.2.0", "--date", "2026-05-28", "--stdout", "--json", "--explain"]);
  const summary = JSON.parse(out);
  assert.equal(summary.selection_report.stage_counts.input, 4);
  assert.equal(summary.selection_report.excluded_counts.status, 1);
  assert.match(summary.selection_report.hints.join(" "), /--status/);
});

test("CLI --explain keeps markdown stdout byte-identical and writes diagnostics to stderr", () => {
  const input = writeFixture();
  const result = runCliDetailed(["--input", input, "--version", "1.2.0", "--date", "2026-05-28", "--stdout", "--explain"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, BASELINE);
  assert.match(result.stderr, /Selection report:/);
  assert.match(result.stderr, /Hint:/);
});

test("CLI --changelog-json --explain includes selection diagnostics", () => {
  const input = writeFixture();
  const out = runCli(["--input", input, "--version", "1.2.0", "--date", "2026-05-28", "--changelog-json", "--explain"]);
  const doc = JSON.parse(out);
  assert.equal(doc.item_count, 3);
  assert.equal(doc.selection_report.stage_counts.input, 4);
  assert.equal(doc.selection_report.stage_counts.visible_items, 3);
});

test("CLI --check exit code contract is preserved (1 when changed, 0 when up to date)", () => {
  const input = writeFixture();
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-chk-"));
  const out = join(dir, "CHANGELOG.md");
  const args = ["--input", input, "--version", "1.2.0", "--date", "2026-05-28", "--output", out];
  // Missing file -> check should exit non-zero.
  let dirtyCode = 0;
  try {
    execFileSync(process.execPath, [CLI, ...args, "--check"], { encoding: "utf-8", stdio: "ignore" });
  } catch (error) {
    dirtyCode = (error as { status?: number }).status ?? -1;
  }
  assert.equal(dirtyCode, 1, "check must exit 1 when output would change");
  // Write it, then check should exit 0.
  execFileSync(process.execPath, [CLI, ...args], { stdio: "ignore" });
  const cleanCode = (() => {
    try {
      execFileSync(process.execPath, [CLI, ...args, "--check"], { stdio: "ignore" });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? -1;
    }
  })();
  assert.equal(cleanCode, 0, "check must exit 0 when output is up to date");
});
