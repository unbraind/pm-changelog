/** Prove every review regression rejects its old behavior in a disposable copy. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pm-stable-review-revert-"));
try {
  for (const file of ["src", "docs", "README.md", "CHANGELOG.md", "package.json"]) cpSync(resolve(file), join(scratch, file), { recursive: true });
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");
  mkdirSync(join(scratch, "test"));
  for (const file of ["stable-itemless-check.test.ts", "release-context.test.ts", "shipped-docs.test.ts", "git-fixture.ts"]) cpSync(resolve("test", file), join(scratch, "test", file));
  const releaseFile = readFileSync(join(scratch, "src/release-context.ts"), "utf8");
  const start = releaseFile.indexOf("function compareSameInstantTagNames(");
  const end = releaseFile.indexOf("\nfunction compareTagNames(", start);
  assert.ok(start > 0 && end > start);
  for (const mutation of [
    { name: "pair-dependent-ordering", file: "src/release-context.ts", test: "release-context.test.ts", pattern: "uses a total alias-invariant order", from: releaseFile.slice(start, end), to: `function compareSameInstantTagNames(a: string, b: string): number {
      const left = formatTagVersion(a).match(/^(\\d{4}\\.\\d{1,2}\\.\\d{1,2})(?:-(\\d+))?$/);
      const right = formatTagVersion(b).match(/^(\\d{4}\\.\\d{1,2}\\.\\d{1,2})(?:-(\\d+))?$/);
      if (left && right && left[1] === right[1]) {
        const x = BigInt(left[2] ?? "0"), y = BigInt(right[2] ?? "0");
        if (x !== y) return x > y ? -1 : 1;
      }
      return compareTagNames(a, b);
    }
` },
    { name: "case-sensitive-ref-guard", file: "test/git-fixture.ts", test: "stable-itemless-check.test.ts", pattern: "^alias fixture", from: "existing.toLowerCase() === name.toLowerCase()", to: "existing === name" },
    { name: "stale-options-contract", file: "docs/usage.md", test: "shipped-docs.test.ts", pattern: "documents the empty Unreleased exception", from: "Keep empty versioned release sections as `No changes.` (the requested `--version` or tag windows with `--all-release-tags`). Empty `Unreleased` sections are always omitted. Without this flag, empty release sections are omitted.", to: "Emit an empty section when no items match. When using `--all-release-tags`, empty release windows are omitted by default; pass this flag to keep them as `No changes.` sections." },
  ]) {
    const file = join(scratch, mutation.file);
    const original = readFileSync(file, "utf8");
    assert.ok(original.includes(mutation.from), mutation.name);
    const run = () => spawnSync(process.execPath, ["--test", "--test-concurrency=2", `--test-name-pattern=${mutation.pattern}`, `test/${mutation.test}`], { cwd: scratch, encoding: "utf8", timeout: 120000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", DO_NOT_TRACK: "1" } });
    const fixed = run();
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
    try {
      writeFileSync(file, original.replace(mutation.from, mutation.to));
      const reverted = run();
      assert.equal(reverted.status, 1, reverted.stdout + reverted.stderr);
      assert.match(reverted.stdout, /fail 1\b/);
      assert.match(reverted.stdout, /ERR_ASSERTION|AssertionError/);
    } finally { writeFileSync(file, original); }
    const restored = run();
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, /pass 1\b/);
    console.log(JSON.stringify({ mutation: mutation.name, fixed_pass: 1, reverted_fail: 1, restored_pass: 1 }));
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
