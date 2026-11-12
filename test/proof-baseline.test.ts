import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { readProofBaseline } from "../scripts/proof-baseline.ts";
import { fixtureEnvironment, initGitFixture, cloneGitFixture } from "./git-fixture.ts";

/** Create a source fixture with a real branch-local baseline and no inherited Git identity. */
function repository(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pm-proof-baseline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  initGitFixture(root, ["-b", "main"]);
  /** Commit only explicit fixture paths with the prescribed synthetic identity. */
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=SteveBot", "-c", "user.email=1153461+unbraind@users.noreply.github.com", ...args], { cwd: root, env: fixtureEnvironment(), stdio: "pipe" });
  writeFileSync(join(root, "src/cli.ts"), "base source\n");
  git("add", "src/cli.ts"); git("commit", "-m", "Fixture base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-b", "feature");
  writeFileSync(join(root, "src/cli.ts"), "working source\n");
  git("add", "src/cli.ts"); git("commit", "-m", "Fixture feature");
  return { root, git };
}

test("proof baseline is unchanged when remote main advances through HEAD ancestors", (t) => {
  const f = repository(t);
  const before = readProofBaseline(f.root);
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  assert.deepEqual(readProofBaseline(f.root), before);
  assert.deepEqual(before, { source: "working source\n", kind: "working-tree" });
});

test("proof baseline falls back in fresh single-branch clones and plain source archives", (t) => {
  const f = repository(t);
  const clone = join(f.root, "clone");
  cloneGitFixture(clone, ["--single-branch", "--branch", "feature", f.root]);
  const archive = mkdtempSync(join(tmpdir(), "pm-proof-archive-"));
  t.after(() => rmSync(archive, { recursive: true, force: true }));
  for (const cwd of [clone, archive, join(f.root, "archive")]) {
    if (cwd !== clone) {
      mkdirSync(join(cwd, "src"), { recursive: true });
      cpSync(join(f.root, "src/cli.ts"), join(cwd, "src/cli.ts"));
    }
    const prior = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = join(f.root, ".git");
      assert.doesNotThrow(() => assert.deepEqual(readProofBaseline(cwd), { source: "working source\n", kind: "working-tree" }));
    } finally {
      if (prior === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prior;
    }
  }
});

test("proof baseline uses checked-out source if the merge-base tree predates the source file", (t) => {
  const f = repository(t);
  f.git("checkout", "--orphan", "empty-base");
  f.git("rm", "-f", "src/cli.ts"); f.git("commit", "--allow-empty", "-m", "Fixture empty base");
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  f.git("merge", "feature", "--allow-unrelated-histories", "-m", "Fixture merge");
  assert.deepEqual(readProofBaseline(f.root), { source: "working source\n", kind: "working-tree" });
});

test("proof controls complete in a fresh clone and a source archive without origin/main", { timeout: 600000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "pm-proof-portable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"); mkdirSync(source);
  for (const folder of ["src", "dist", "scripts", "test", "docs", ".github"]) cpSync(resolve(folder), join(source, folder), { recursive: true });
  for (const file of ["package.json", "manifest.json", ".gitignore"]) cpSync(resolve(file), join(source, file));
  const pmRoot = join(source, ".agents/pm");
  mkdirSync(join(pmRoot, "issues"), { recursive: true }); mkdirSync(join(pmRoot, "history"));
  cpSync(resolve(".agents/pm/settings.json"), join(pmRoot, "settings.json"));
  for (const id of ["pmc-total-item-order", "pmc-contract-changes", "pmc-stable-itemless-check", "pmc-no-empty-unreleased-337"]) {
    for (const path of [`issues/${id}.toon`, `history/${id}.jsonl`]) cpSync(resolve(".agents/pm", path), join(pmRoot, path));
  }
  initGitFixture(source, ["-b", "feature"]);
  execFileSync("git", ["add", "src", "dist", "scripts", "test", "docs", ".github", "package.json", "manifest.json", ".gitignore", ".agents/pm/settings.json", ".agents/pm/issues", ".agents/pm/history"], { cwd: source, env: fixtureEnvironment() });
  execFileSync("git", ["-c", "user.name=SteveBot", "-c", "user.email=1153461+unbraind@users.noreply.github.com", "commit", "-m", "Portable proof fixture"], { cwd: source, env: fixtureEnvironment(), stdio: "pipe" });
  const clone = join(root, "clone"), archive = join(root, "archive");
  cloneGitFixture(clone, ["--single-branch", source]);
  mkdirSync(archive);
  for (const folder of ["src", "dist", "scripts", "test", "docs", ".github", ".agents"]) cpSync(join(source, folder), join(archive, folder), { recursive: true });
  for (const file of ["package.json", "manifest.json"]) cpSync(join(source, file), join(archive, file));
  for (const cwd of [clone, archive]) {
    symlinkSync(resolve("node_modules"), join(cwd, "node_modules"), "junction");
    // The mutation cases run once, through the registered pm test; here only the controls run in each location.
    const result = spawnSync(process.execPath, ["scripts/prove-check-generator-drift-revert.ts", "--baseline-only"], {
      cwd, encoding: "utf8", timeout: 600000,
      env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PM_AUTHOR: "codex-changelog339-1111", PM_TELEMETRY_SOURCE_CONTEXT: "automation", DO_NOT_TRACK: "1" },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /"baseline":"working-tree"/);
    assert.match(result.stdout, /"restored_pass":/);
    assert.doesNotMatch(result.stdout, /"mutation":/);
    assert.match(result.stdout, /"attempted":2,"passed":2,"failed":0/);
    t.diagnostic(`${cwd === clone ? "fresh clone" : "source archive"}: proof controls passed`);
  }
});
