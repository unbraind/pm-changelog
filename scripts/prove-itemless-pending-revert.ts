/** Prove pending defaults and the extraction guard reject behavioral reverts in a disposable copy. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pm-itemless-revert-"));
try {
  cpSync(resolve("src"), join(scratch, "src"), { recursive: true });
  cpSync(resolve("package.json"), join(scratch, "package.json"));
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");
  mkdirSync(join(scratch, "test"));
  for (const file of ["itemless-pending.test.ts", "git-fixture.ts"]) cpSync(resolve("test", file), join(scratch, "test", file));
  /** Execute real-git regressions without printing scratch paths or inherited environment. */
  const run = (pattern: string) => spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, "test/itemless-pending.test.ts"], {
    cwd: scratch, encoding: "utf8", timeout: 120000, env: { PATH: process.env.PATH, DO_NOT_TRACK: "1", TZ: "UTC" },
  });
  for (const mutation of [
    { file: "generator.ts", from: "if (options.dependencyUpdates !== false && options.gitCwd)", to: "if (options.dependencyUpdates && options.gitCwd)", pattern: ".*", failures: 4, tests: 8 },
    { file: "cli.ts", from: "if (!requestedReleaseSuppressed(generationOptions)) assertRequestedRelease(generationOptions);", to: "// Requested-release preflight removed by the proof only.", pattern: "^no pending commits", failures: 1, tests: 1 },
  ]) {
    const file = join(scratch, "src", mutation.file), original = readFileSync(file, "utf8");
    assert.ok(original.includes(mutation.from));
    const fixed = run(mutation.pattern);
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
    assert.match(fixed.stdout, new RegExp(`tests ${mutation.tests}\\b`));
    writeFileSync(file, original.replace(mutation.from, mutation.to));
    const reverted = run(mutation.pattern);
    assert.equal(reverted.status, 1);
    assert.match(reverted.stdout + reverted.stderr, /AssertionError|ERR_ASSERTION/);
    assert.match(reverted.stdout, new RegExp(`fail ${mutation.failures}\\b`));
    writeFileSync(file, original);
    const restored = run(mutation.pattern);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    console.log(JSON.stringify({ source: mutation.file, fixed_pass: mutation.tests, reverted_fail: mutation.failures, restored_pass: mutation.tests, disposable_copy: true }));
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
