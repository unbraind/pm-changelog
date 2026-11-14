import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { PmClient, runInit } from "@unbrained/pm-cli/sdk";
import { initGitFixture, removeGitFixture } from "./git-fixture.ts";

/** Own a native tracker and isolate every CLI child from ambient PM and Git state. */
async function tracker(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pm-include-empty-tracker-"));
  t.after(() => removeGitFixture(dir));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-09T09:00:00Z") });
  const root = join(dir, ".agents/pm");
  await runInit("publication", { path: root }, { defaults: true, agentGuidance: "skip" });
  const client = new PmClient({ pmRoot: root, author: "publication-test" });
  const env = {
    PATH: process.env.PATH, HOME: dir, PM_GLOBAL_PATH: join(dir, "global"),
    PM_AUTHOR: "publication-test", PM_TELEMETRY_SOURCE_CONTEXT: "automation", DO_NOT_TRACK: "1",
    NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: dirname(dir), GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const args = [resolve("src/cli.ts"), "--pm-root", ".agents/pm", "--pm-bin", resolve("node_modules/@unbrained/pm-cli/dist/cli.js"),
    "--respect-item-release", "--mode", "replace", "--output", "CHANGELOG.md"];
  const read = () => readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  /** Record completion independently from title order and later audit timestamps. */
  const deliver = async (id: string, title: string, release: string) => {
    await client.create({ id, title, release, type: "Task", createMode: "progressive", unset: ["parent", "goal", "objective", "sprint"] });
    t.mock.timers.tick(1000);
    await client.close(id, "Implemented the delivery");
  };
  return { dir, root, client, env, args, read, deliver };
}

for (const window of ["empty", "dependency-only", "item-bearing"]) {
  for (const includeEmpty of [false, true]) {
    test(`native tracker: ${window}, include-empty=${includeEmpty}, full/commit/tag/check bytes`, async (t) => {
      const { dir, client, env, args, read, deliver } = await tracker(t);
      initGitFixture(dir);
      const git = (...flags: string[]) => execFileSync("git", flags, { cwd: dir, env, stdio: "pipe" });
      const commit = (subject: string, date: string) => execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", subject],
        { cwd: dir, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: "pipe" });
      const manifest = (version: string) => writeFileSync(join(dir, "package.json"), JSON.stringify({ version, scripts: {
        "changelog:full": [process.execPath, ...args, "--all-release-tags", "--release-version-from-package", "--date-from-version"].map((arg) => JSON.stringify(arg)).join(" "),
        "changelog:check": "npm run changelog:full -- --check",
      } }));
      await deliver("publication-old", "Older release delivery", "2026.11.9");
      manifest("2026.11.9");
      git("add", ".agents/pm", "package.json");
      commit("Release fixture v2026.11.9", "2026-11-09T10:00:00Z");
      git("tag", "v2026.11.9");
      manifest("2026.11.10");
      if (window === "dependency-only") commit("chore(deps): bump example from 1 to 2 (#5)", "2026-11-10T09:00:00Z");
      if (window === "item-bearing") {
        t.mock.timers.tick(24 * 60 * 60 * 1000);
        await deliver("publication-first", "Maintain alpha", "2026.11.10");
        await deliver("publication-second", "Maintain zulu", "2026.11.10");
        t.mock.timers.tick(1000);
        await client.comments("publication-first", { add: "Later audit evidence must not reorder completed entries" });
      }
      const run = (script: string) => {
        const result = spawnSync("npm", ["run", script, "--", ...(includeEmpty ? ["--include-empty"] : [])], { cwd: dir, env, encoding: "utf8" });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        return result;
      };
      run("changelog:full");
      const before = read();
      assert.doesNotMatch(before, /^## Unreleased/m);
      assert.match(before, /## 2026\.11\.9 - 2026-11-09[\s\S]*Older release delivery/);
      assert.equal(before.includes("## 2026.11.10 - 2026-11-10"), includeEmpty || window !== "empty");
      if (window === "dependency-only") assert.match(before, /### Dependencies\n\n- Bump example from 1 to 2 \(#5\)/);
      if (window === "item-bearing") assert.match(before, /Maintain zulu[\s\S]*Maintain alpha/, "completed_at wins over title and later updated_at");
      git("add", ".agents/pm", "CHANGELOG.md", "package.json");
      commit("Release fixture v2026.11.10", "2026-11-10T10:00:00Z");
      git("tag", "v2026.11.10");
      assert.match(run("changelog:check").stderr, /Changelog is up to date/);
      assert.equal(read(), before, "check preserves committed bytes");
      run("changelog:full");
      assert.equal(read(), before, "fresh post-tag output equals pre-tag output");
    });
  }
}

for (const populated of [false, true]) {
  for (const includeEmpty of [false, true]) {
    test(`native tracker without git: recorded releases=${populated}, include-empty=${includeEmpty}`, async (t) => {
      const { dir, env, args, read, deliver } = await tracker(t);
      if (populated) {
        await deliver("publication-old", "Older release delivery", "2026.11.9");
        t.mock.timers.tick(24 * 60 * 60 * 1000);
        await deliver("publication-current", "Current release delivery", "2026.11.10");
      }
      const noGit = join(dir, "bin");
      mkdirSync(noGit);
      symlinkSync(process.execPath, join(noGit, "node"));
      const flags = [...args, "--group-by", "release", "--no-dependency-updates", ...(includeEmpty ? ["--include-empty"] : [])];
      const run = (...extra: string[]) => {
        const result = spawnSync(process.execPath, [...flags, ...extra], { cwd: dir, env: { ...env, PATH: noGit }, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        return result;
      };
      run();
      const before = read();
      if (populated) assert.match(before, /## 2026\.11\.10[\s\S]*Current release delivery[\s\S]*## 2026\.11\.9[\s\S]*Older release delivery/);
      else assert.equal(before, "# Changelog\n");
      assert.doesNotMatch(before, /^## Unreleased/m);
      assert.match(run("--check").stderr, /Changelog is up to date/);
      run();
      assert.equal(read(), before);
    });
  }
}
