/** Verify tag-stability regressions reject behavioral reverts in a disposable copy. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pm-stable-revert-"));
try {
  cpSync(resolve("src"), join(scratch, "src"), { recursive: true });
  cpSync(resolve("package.json"), join(scratch, "package.json"));
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");
  mkdirSync(join(scratch, "test"));
  for (const file of ["stable-itemless-check.test.ts", "git-fixture.ts"]) cpSync(resolve("test", file), join(scratch, "test", file));
  /** Run only the stability property and visibility regressions with isolated Git identity. */
  const run = () => spawnSync(process.execPath, ["--test", "--test-concurrency=2", "--test-name-pattern=^property:|^empty Unreleased", "test/stable-itemless-check.test.ts"], {
    cwd: scratch, encoding: "utf8", timeout: 180000,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", DO_NOT_TRACK: "1" },
  });
  for (const mutation of [
    { name: "empty-unreleased-restored", file: "generator.ts", from: "|| (options.includeEmpty && sectionVersionKey(section.heading) !== undefined)", to: "|| options.includeEmpty", failures: 2 },
    { name: "v-only-discovery-restored", file: "release-context.ts", from: 'pattern ?? "*"', to: 'pattern ?? "v*"', failures: 1 },
    { name: "duplicate-windows-restored", file: "release-context.ts", from: "if (seen.has(key)) return false;", to: "if (seen.has(key)) return true;", failures: 1 },
  ]) {
    const file = join(scratch, "src", mutation.file);
    const fixed = readFileSync(file, "utf8");
    assert.ok(fixed.includes(mutation.from), mutation.name);
    assert.equal(run().status, 0, `fixed ${mutation.name}`);
    try {
      writeFileSync(file, fixed.replace(mutation.from, mutation.to));
      const reverted = run();
      assert.equal(reverted.status, 1, reverted.stdout + reverted.stderr);
      assert.match(reverted.stdout, new RegExp(`fail ${mutation.failures}\\b`));
      assert.match(reverted.stdout, /ERR_ASSERTION|AssertionError/);
    } finally { writeFileSync(file, fixed); }
    assert.equal(run().status, 0, `restored ${mutation.name}`);
    console.log(JSON.stringify({ mutation: mutation.name, fixed_pass: 2, reverted_fail: mutation.failures, restored_pass: 2 }));
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
