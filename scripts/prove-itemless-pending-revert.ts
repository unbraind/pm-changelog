/** Prove stable itemless defaults and the extraction guard reject behavioral reverts in a disposable copy. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pm-itemless-revert-"));
try {
  cpSync(resolve("src"), join(scratch, "src"), { recursive: true });
  cpSync(resolve("package.json"), join(scratch, "package.json"));
  cpSync(resolve("manifest.json"), join(scratch, "manifest.json"));
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");
  mkdirSync(join(scratch, "test"));
  for (const file of ["itemless-pending.test.ts", "extension.test.ts", "git-fixture.ts"]) cpSync(resolve("test", file), join(scratch, "test", file));
  /** Execute real-git regressions without printing scratch paths or inherited environment. */
  const run = (pattern: string, testFile = "itemless-pending.test.ts") => spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, `test/${testFile}`], {
    cwd: scratch, encoding: "utf8", timeout: 300000, env: { PATH: process.env.PATH, DO_NOT_TRACK: "1", TZ: "UTC" },
  });
  for (const mutation of [
    { name: "default-disabled", file: "generator.ts", from: "if (options.dependencyUpdates !== false && options.gitCwd)", to: "if (options.dependencyUpdates && options.gitCwd)", pattern: "itemless pending default|single pending fallback", failures: 3, tests: 3 },
    { name: "tag-retention-removed", file: "generator.ts", from: 'return findMarkdownHeadings(result.stdout, "##").some(({ heading: found }) => found === version || found.startsWith(`${version} - `));', to: "return false;", pattern: "fleet CLI transition|tagged single and all-window|SDK committed|CLI uses custom", failures: 8, tests: 8 },
    { name: "history-rewritten", file: "generator.ts", from: "if (!tag) return false;", to: "return true;", pattern: "tagged itemless history|tagged default rejects", failures: 5, tests: 5 },
    { name: "generic-subjects-restored", file: "generator.ts", from: "const parsed = parseDependencyCommitForRendering(line.trim(), renderingVersion);", to: "const parsed = parseDependencyCommitForRendering(line.trim(), renderingVersion) ?? { subject: line.trim(), description: line.trim(), prNumber: undefined };", pattern: "docs, a Dependabot-shaped merge", failures: 1, tests: 1 },
    { name: "merges-restored", file: "generator.ts", from: '["log", "--format=%s", "--no-merges"]', to: '["log", "--format=%s"]', pattern: "docs, a Dependabot-shaped merge", failures: 1, tests: 1 },
    { name: "empty-subject-hash-restored", file: "generator.ts", from: '["log", "--format=%s", "--no-merges"]', to: '["log", "--format=%h%x00%s", "--no-merges"]', extraFrom: "const parsed = parseDependencyCommitForRendering(line.trim(), renderingVersion);", extraTo: 'const subject = line.slice(line.indexOf("\\0") + 1).trim() || `Commit ${line.slice(0, line.indexOf("\\0"))}`; const parsed = parseDependencyCommitForRendering(subject, renderingVersion) ?? { subject, description: subject, prNumber: undefined };', pattern: "^empty subjects", failures: 1, tests: 1 },
    { name: "generate-output-path-removed", file: "extension.ts", from: '\n          changelogPath: resolve(stringOption(ctx.options, "output", "output") ?? "CHANGELOG.md"),', to: '\n          changelogPath: "CHANGELOG.md",', pattern: "generate and export retain itemless", testFile: "extension.test.ts", failures: 1, tests: 1 },
    { name: "export-output-path-removed", file: "extension.ts", from: '\n        changelogPath: resolve(stringOption(ctx.options, "output", "output") ?? "CHANGELOG.md"),', to: '\n        changelogPath: "CHANGELOG.md",', pattern: "generate and export retain itemless", testFile: "extension.test.ts", failures: 1, tests: 1 },
    { name: "cli-output-path-unresolved", file: "cli.ts", from: 'changelogPath: options.stdout ? "CHANGELOG.md" : resolve(options.output),', to: 'changelogPath: options.stdout ? "CHANGELOG.md" : options.output,', pattern: "even when --pm-cwd", failures: 1, tests: 1 },
    { name: "full-history-refusal-restored", file: "cli.ts", from: "(!options.allReleaseTags || options.stdout || options.limit !== undefined || options.sinceVersion !== undefined)) assertRequestedRelease(generationOptions);", to: "true) assertRequestedRelease(generationOptions);", pattern: "^full-file history", failures: 2, tests: 2 },
    { name: "extension-full-history-refusal-restored", file: "extension.ts", from: "(!allReleaseTags || stdout || limitValue !== undefined || generationOptions.sinceVersion !== undefined)) withRequestedReleaseDiagnostics", to: "true) withRequestedReleaseDiagnostics", pattern: "generate and export retain itemless", testFile: "extension.test.ts", failures: 1, tests: 1 },
    { name: "requested-release-guard-removed", file: "cli.ts", from: "(!options.allReleaseTags || options.stdout || options.limit !== undefined || options.sinceVersion !== undefined)) assertRequestedRelease(generationOptions);", to: "false) assertRequestedRelease(generationOptions);", pattern: "^no pending commits", failures: 1, tests: 1 },
  ]) {
    const file = join(scratch, "src", mutation.file), original = readFileSync(file, "utf8");
    assert.ok(original.includes(mutation.from), mutation.name);
    const testFile = "testFile" in mutation ? mutation.testFile : undefined;
    const fixed = run(mutation.pattern, testFile);
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
    assert.match(fixed.stdout, new RegExp(`tests ${mutation.tests}\\b`));
    assert.match(fixed.stdout, new RegExp(`pass ${mutation.tests}\\b`));
    assert.match(fixed.stdout, /skipped 0\b/);
    let changed = original.replace(mutation.from, mutation.to);
    if (mutation.extraFrom !== undefined && mutation.extraTo !== undefined) {
      assert.ok(changed.includes(mutation.extraFrom));
      changed = changed.replace(mutation.extraFrom, mutation.extraTo);
    }
    writeFileSync(file, changed);
    const reverted = run(mutation.pattern, testFile);
    assert.equal(reverted.status, 1, reverted.stdout + reverted.stderr);
    assert.match(reverted.stdout + reverted.stderr, mutation.file === "extension.ts" ? /MISSING_REQUESTED_RELEASE/ : /AssertionError|ERR_ASSERTION/);
    assert.match(reverted.stdout, new RegExp(`fail ${mutation.failures}\\b`));
    assert.match(reverted.stdout, new RegExp(`pass ${mutation.tests - mutation.failures}\\b`));
    assert.match(reverted.stdout, /skipped 0\b/);
    writeFileSync(file, original);
    const restored = run(mutation.pattern, testFile);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, new RegExp(`pass ${mutation.tests}\\b`));
    assert.match(restored.stdout, /skipped 0\b/);
    console.log(JSON.stringify({ mutation: mutation.name, source: mutation.file, fixed_pass: mutation.tests, reverted_fail: mutation.failures, restored_pass: mutation.tests, disposable_copy: true }));
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
