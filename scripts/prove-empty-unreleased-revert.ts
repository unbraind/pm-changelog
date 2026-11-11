/** Prove issue 337 regressions reject behavioral reverts in an owned disposable copy. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pm-empty-unreleased-revert-"));
try {
  cpSync(resolve("src"), join(scratch, "src"), { recursive: true });
  cpSync(resolve("package.json"), join(scratch, "package.json"));
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");
  mkdirSync(join(scratch, "test"));
  for (const file of ["empty-unreleased.test.ts", "git-fixture.ts"]) cpSync(resolve("test", file), join(scratch, "test", file));
  const file = join(scratch, "src/generator.ts");
  const fixed = readFileSync(file, "utf8");
  const run = () => spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/empty-unreleased.test.ts"], {
    cwd: scratch, encoding: "utf8", timeout: 240000,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", DO_NOT_TRACK: "1" },
  });
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  assert.match(baseline.stdout, /# pass 9\b/);
  for (const mutation of [
    { name: "restore-empty-Unreleased-visibility", from: "|| (options.includeEmpty && sectionVersionKey(section.heading) !== undefined)", to: "|| options.includeEmpty", failures: 8 },
    { name: "revert-prepend-cleanup", from: "let next = renderingVersion === PREVIOUS_RENDERING_VERSION ? existing : omitEmptyUnreleasedSections(existing);", to: "let next = existing;", failures: 2 },
    { name: "drop-nonempty-Unreleased", from: "const candidateSections = selectCandidateSections(sections, options);", to: 'const candidateSections = selectCandidateSections(sections, options).filter((section) => normalizeReleaseHeadingKey(section.heading) !== "unreleased");', failures: 2 },
    { name: "drop-dependency-only-sections", from: "|| (section.dependencyCommits?.length ?? 0) > 0", to: "|| false", failures: 2 },
  ]) {
    assert.ok(fixed.includes(mutation.from), mutation.name);
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
  }
  const restored = run();
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  assert.match(restored.stdout, /# pass 9\b/);
  console.log(JSON.stringify({ restored_pass: 9 }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
