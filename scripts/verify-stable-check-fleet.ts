/** Compare public tracker snapshots before/after tagging without modifying the supplied clones. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveReleaseContext } from "../src/release-context.ts";

const cli = resolve("src/cli.ts");
const pmBin = resolve("node_modules/.bin/pm");
for (const source of process.argv.slice(2)) {
  const scratch = mkdtempSync(join(tmpdir(), "pm-stable-fleet-"));
  const cwd = join(scratch, "repo");
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", DO_NOT_TRACK: "1" };
  try {
    execFileSync("git", ["clone", "--quiet", "--shared", resolve(source), cwd], { env, stdio: "pipe" });
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name: string; version: string; scripts: Record<string, string> };
    const context = resolveReleaseContext({ cwd, version: pkg.version });
    assert.ok(context.releaseTag, `${pkg.name} needs its package release tag`);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, env, encoding: "utf8" }).trim();
    const tagCommit = execFileSync("git", ["rev-parse", `${context.releaseTag}^{commit}`], { cwd, env, encoding: "utf8" }).trim();
    const args = [cli, "--pm-root", ".agents/pm", "--mode", "replace", "--output", "CHANGELOG.md", "--all-release-tags", "--release-version-from-package", "--date-from-version", "--item-url-base", `https://github.com/unbraind/${pkg.name}/blob/main/.agents/pm`, "--respect-item-release", "--include-empty", "--pm-bin", pmBin, "--pm-arg=--output-budget", "--pm-arg=unbounded", "--pm-arg=--output-limit", "--pm-arg=unbounded"];
    if (pkg.scripts["changelog:check"]?.includes("--breaking-changes")) args.push("--breaking-changes");
    /** Capture a canonical render or check using the consumer's projection flags. */
    const run = (...extra: string[]) => spawnSync(process.execPath, [...args, ...extra], { cwd, env, encoding: "utf8", timeout: 180000 });
    // Freeze the release preparation snapshot: later main commits are additional changes.
    execFileSync("git", ["checkout", "--quiet", "--detach", tagCommit], { cwd, env, stdio: "pipe" });
    const original = readFileSync(join(cwd, "CHANGELOG.md"), "utf8");
    const originalAfter = run("--check");
    const after = run("--stdout");
    assert.equal(after.status, 0, after.stderr);
    execFileSync("git", ["tag", "-d", context.releaseTag], { cwd, env, stdio: "pipe" });
    const originalBefore = run("--check");
    const before = run("--stdout");
    assert.equal(before.status, 0, before.stderr);
    writeFileSync(join(scratch, "before.md"), before.stdout);
    writeFileSync(join(scratch, "after.md"), after.stdout);
    const tagDiff = spawnSync("diff", ["-u", join(scratch, "before.md"), join(scratch, "after.md")], { encoding: "utf8" }).stdout.split("\n").filter((line) => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line));
    // Use a separate generated baseline to distinguish generator migration drift from tag drift.
    writeFileSync(join(cwd, "CHANGELOG.md"), before.stdout);
    const beforeCheck = run("--check");
    assert.equal(beforeCheck.status, 0, beforeCheck.stderr);
    execFileSync("git", ["tag", context.releaseTag, tagCommit], { cwd, env, stdio: "pipe" });
    const afterCheck = run("--check");

    console.log(JSON.stringify({ repository: pkg.name, source_head: head, release_snapshot: tagCommit, version: pkg.version, tag: context.releaseTag,
      original_before_check: originalBefore.status, original_after_check: originalAfter.status,
      generated_before_check: beforeCheck.status, generated_after_check: afterCheck.status,
      tag_only_equal: after.stdout === before.stdout, tag_diff: tagDiff, original_equal_current_generator: original === before.stdout,
      bytes: Buffer.byteLength(before.stdout), sha256: createHash("sha256").update(before.stdout).digest("hex"),
      original_diff: originalAfter.stderr.split("\n").filter((line) => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line)).slice(0, 8),
    }));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
