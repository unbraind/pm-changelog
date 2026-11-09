/** Verify fixture policy through real Git config and production-style commands. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("git fixtures ignore repository overrides for initialization, cloning and tag aliases", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "pm-git-location-"));
  t.after(() => removeGitFixture(scratch));
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
  const intended = join(scratch, "intended"), foreign = join(scratch, "foreign");
  for (const cwd of [intended, foreign]) {
    mkdirSync(cwd);
    initGitFixture(cwd);
    writeFileSync(join(cwd, "tracked.txt"), "fixture\n");
    git(cwd, "add", "tracked.txt");
    git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  }
  git(foreign, "tag", "foreign-only");
  git(foreign, "config", "gc.auto", "17");
  const foreignRefs = git(foreign, "show-ref");
  const foreignConfig = readFileSync(join(foreign, ".git/config"));
  const foreignIndex = readFileSync(join(foreign, ".git/index"));
  const overrides = {
    GIT_DIR: join(foreign, ".git"), GIT_WORK_TREE: foreign,
    GIT_INDEX_FILE: join(foreign, ".git/index"), GIT_OBJECT_DIRECTORY: join(foreign, ".git/objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(foreign, ".git/objects"), GIT_COMMON_DIR: join(foreign, ".git"),
    GIT_NAMESPACE: "foreign-namespace", GIT_PREFIX: "foreign-prefix/",
  };
  const cases = [...Object.entries(overrides).map(([key, value]) => ({ [key]: value })), overrides];
  for (const [index, inherited] of cases.entries()) {
    const initialized = join(scratch, `init-${index}`), cloned = join(scratch, `clone-${index}`);
    mkdirSync(initialized);
    const name = index === 0 ? "foreign-only" : `alias-${index}`;
    const source = `import assert from 'node:assert/strict';
      import { initGitFixture, cloneGitFixture, addGitTagAlias } from ${JSON.stringify(new URL("./git-fixture.ts", import.meta.url).href)};
      initGitFixture(${JSON.stringify(initialized)});
      cloneGitFixture(${JSON.stringify(cloned)}, [${JSON.stringify(intended)}]);
      assert.equal(addGitTagAlias(${JSON.stringify(cloned)}, ${JSON.stringify(name)}, 'HEAD'), true);
      assert.equal(addGitTagAlias(${JSON.stringify(cloned)}, ${JSON.stringify(name.toUpperCase())}, 'HEAD'), false);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: { ...env, ...inherited }, encoding: "utf8" });
    assert.equal(result.status, 0, `${Object.keys(inherited).join(",")}: ${result.stderr}`);
    assert.equal(git(initialized, "config", "--local", "gc.auto"), "0");
    assert.equal(git(cloned, "tag", "--list"), name);
    assert.equal(git(intended, "tag", "--list"), "");
    assert.equal(git(foreign, "show-ref"), foreignRefs);
    assert.deepEqual(readFileSync(join(foreign, ".git/config")), foreignConfig);
    assert.deepEqual(readFileSync(join(foreign, ".git/index")), foreignIndex);
  }
});
