/** Verify fixture policy through real Git config and production-style commands. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cloneGitFixture, initGitFixture, removeGitFixture } from "./git-fixture.ts";

/** Check persisted policy without supplying command-line overrides. */
function assertForegroundPolicy(directory: string): void {
  for (const [key, expected] of [["gc.auto", "0"], ["maintenance.auto", "false"], ["core.fsmonitor", "false"]]) {
    assert.equal(execFileSync("git", ["config", "--local", "--get", key], { cwd: directory, encoding: "utf8" }).trim(), expected);
  }
  execFileSync("git", ["status", "--porcelain"], { cwd: directory });
}

test("Git fixtures persist foreground policy for normal, bare and cloned repositories", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-git-fixture-"));
  t.after(() => removeGitFixture(directory));
  const bare = join(directory, "bare");
  const source = join(directory, "source");
  // Git init requires an existing cwd; cloning creates its destination itself.
  initGitFixture(directory, ["--quiet", "--initial-branch=main"]);
  assertForegroundPolicy(directory);
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Fixture"], { cwd: directory });
  cloneGitFixture(source, ["--quiet", directory]);
  assertForegroundPolicy(source);
  cloneGitFixture(bare, ["--quiet", "--bare", directory]);
  for (const key of ["gc.auto", "maintenance.auto", "core.fsmonitor"]) {
    assert.equal(execFileSync("git", ["config", "--local", "--get", key], { cwd: bare, encoding: "utf8" }).trim(), key === "gc.auto" ? "0" : "false");
  }
});

test("Git fixture removal handles an existing repository and repeated cleanup", () => {
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-git-cleanup-"));
  try {
    initGitFixture(directory, ["--quiet", "--bare"]);
  } finally {
    removeGitFixture(directory);
  }
  assert.equal(existsSync(directory), false);
  removeGitFixture(directory);
});
