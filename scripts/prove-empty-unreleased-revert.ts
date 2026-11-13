/** Prove issue 337 regressions reject behavioral reverts in an owned disposable copy. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProofRun } from "./proof-run.ts";
import { emptyUnreleasedMutation } from "./empty-unreleased-proof.ts";

const scratch = mkdtempSync(join(tmpdir(), "pm-empty-unreleased-revert-"));
try {
  cpSync(resolve("src"), join(scratch, "src"), { recursive: true });
  cpSync(resolve("package.json"), join(scratch, "package.json"));
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");
  mkdirSync(join(scratch, "test"));
  for (const file of ["empty-unreleased.test.ts", "git-fixture.ts"]) cpSync(resolve("test", file), join(scratch, "test", file));
  const file = join(scratch, "src/generator.ts");
  const fixed = readFileSync(file, "utf8");
  const run = () => spawnSync(process.execPath, ["--test", "--test-concurrency=2", "--test-reporter=tap", "test/empty-unreleased.test.ts"], {
    cwd: scratch, encoding: "utf8", timeout: 240000,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", DO_NOT_TRACK: "1" },
  });
  const proof = new ProofRun();
  proof.run("fixed-controls", () => {
    const baseline = run();
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    assert.match(baseline.stdout, /# pass 9\b/);
  });
  for (const name of ["restore-empty-Unreleased-visibility", "revert-prepend-cleanup", "drop-nonempty-Unreleased", "drop-dependency-only-sections"]) {
    proof.run(name, () => {
      const mutation = emptyUnreleasedMutation(fixed, name);
      try {
        writeFileSync(file, fixed.replace(mutation.from, mutation.to));
        const reverted = run();
        assert.equal(reverted.status, 1, reverted.stdout + reverted.stderr);
        assert.match(reverted.stdout, new RegExp(`# fail ${mutation.failures}\\b`));
        assert.match(reverted.stdout, /ERR_ASSERTION|AssertionError/);
        const failed = [...reverted.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]);
        assert.equal(failed.length, mutation.failures);
        console.log(JSON.stringify({ mutation: mutation.name, fixed_pass: 9, reverted_fail: mutation.failures, failed_tests: failed }));
      } finally { writeFileSync(file, fixed); }
    });
  }
  proof.run("restored-controls", () => {
    const restored = run();
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, /# pass 9\b/);
    console.log(JSON.stringify({ restored_pass: 9 }));
  });
  proof.finish();
} finally { rmSync(scratch, { recursive: true, force: true }); }
