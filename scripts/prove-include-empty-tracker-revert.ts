/** Prove native tracker publication tests reject the pre-337 empty-section rule. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emptyUnreleasedMutation } from "./empty-unreleased-proof.ts";

const scratch = mkdtempSync(join(tmpdir(), "pm-native-tracker-revert-"));
try {
  cpSync(resolve("src"), join(scratch, "src"), { recursive: true });
  cpSync(resolve("package.json"), join(scratch, "package.json"));
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");
  mkdirSync(join(scratch, "test"));
  for (const name of ["include-empty-tracker.test.ts", "git-fixture.ts"]) cpSync(resolve("test", name), join(scratch, "test", name));
  const file = join(scratch, "src/generator.ts");
  const fixed = readFileSync(file, "utf8");
  /** Run the same source tests before, during and after the single-function revert. */
  const run = () => spawnSync(process.execPath, ["--test", "--test-concurrency=2", "--test-reporter=tap", "test/include-empty-tracker.test.ts"], {
    cwd: scratch, encoding: "utf8", timeout: 240000,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", DO_NOT_TRACK: "1" },
  });
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  assert.match(baseline.stdout, /# pass 10\b/);
  const mutation = emptyUnreleasedMutation(fixed, "restore-empty-Unreleased-visibility");
  try {
    writeFileSync(file, fixed.replace(mutation.from, mutation.to));
    const reverted = run();
    assert.equal(reverted.status, 1, reverted.stdout + reverted.stderr);
    assert.match(reverted.stdout, /# fail 3\b/);
    const failed = [...reverted.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]);
    assert.equal(failed.length, 3);
    for (const name of failed) assert.match(name, /native tracker: (empty|dependency-only|item-bearing), include-empty=true/);
    assert.match(reverted.stdout, /Changelog is out of date/);
    console.log(JSON.stringify({ mutation: mutation.name, fixed_pass: 10, reverted_pass: 7, reverted_fail: 3, failed_tests: failed }));
  } finally { writeFileSync(file, fixed); }
  const restored = run();
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  assert.match(restored.stdout, /# pass 10\b/);
  console.log(JSON.stringify({ restored_pass: 10 }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
