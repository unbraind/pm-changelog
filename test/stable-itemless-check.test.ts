import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { runInit } from "@unbrained/pm-cli/sdk";
import { buildChangelogDocument, createChangelog, createChangelogSummary, explainChangelogSelection, resolveReleaseTagWindows } from "../src/index.ts";
import { cliTestSurface } from "../src/cli.ts";
import { visibleChangelogItems } from "../src/generator.ts";
import type { GenerateChangelogOptions, PmItem } from "../src/index.ts";
import { addGitTagAlias, initGitFixture, removeGitFixture } from "./git-fixture.ts";

/** A reproducible PRNG makes random histories replayable without another dependency. */
function random(seed: number): () => number {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
}

/** Observe all public visibility projections, including a one-section extraction. */
function projection(options: GenerateChangelogOptions): unknown {
  return [undefined, 1].map((limit) => {
    const selected = { ...options, limit };
    return {
      markdown: createChangelog(selected).markdown,
      document: buildChangelogDocument(selected),
      summary: createChangelogSummary(selected),
      items: visibleChangelogItems(selected),
      visible: explainChangelogSelection(selected).stage_counts.visible_items,
    };
  });
}

test("property: publishing release tags preserves empty and item-bearing random histories", (t) => {
  const next = random(0x11072026);
  const dir = mkdtempSync(join(tmpdir(), "pm-stable-tags-"));
  t.after(() => removeGitFixture(dir));
  initGitFixture(dir);
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: "pipe" }).trim();
  /** Commit with a fixed release boundary, independent of the wall clock. */
  const commit = (timestamp: string) => {
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "docs: fixture"], { cwd: dir, env: { ...env, GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp }, stdio: "pipe" });
    return git("rev-parse", "HEAD");
  };
  const historical = Array.from({ length: 5 }, (_, index) => commit(`2026-10-${String(index + 1).padStart(2, "0")}T10:00:00Z`));
  const previousSameDay = commit("2026-11-07T09:00:00Z");
  const target = commit("2026-11-07T10:00:00Z");
  commit("2026-11-07T11:00:00Z"); // Tag an older commit, not HEAD.
  const spellings = ["v2026.11.07", "2026.11.7", "v2026.11.7", "2026.11.07"];
  for (let trial = 0; trial < 48; trial++) {
    const tags = git("tag", "--list").split("\n").filter(Boolean);
    if (tags.length) git("tag", "-d", ...tags);
    git("tag", "docs-snapshot", historical[0]!);
    const items: PmItem[] = [];
    for (let index = 0; index < historical.length; index++) {
      if (next() < 0.3) continue;
      const version = `2026.10.${index + 1}`;
      git("tag", `${next() < 0.5 ? "v" : ""}2026.10.${next() < 0.5 ? "0" : ""}${index + 1}`, historical[index]!);
      if (next() < 0.5) items.push({ id: `old-${index}`, title: `Historical ${index}`, status: "closed", release: version });
    }
    // Adding an alias on an older commit preserves that window as well.
    const olderAliases = git("tag", "--list").split("\n").filter((name) => name !== "docs-snapshot" && Boolean(name));
    const suffix = trial % 2 === 0 ? "" : "-2";
    if (suffix) git("tag", "v2026.11.7", trial % 4 === 3 ? target : previousSameDay);
    const version = `2026.11.7${suffix}`;
    if (trial % 3 !== 0) items.push({ id: "current", title: "Delivered release item", status: "closed", release: version });
    // Alternate explicit and timestamp-only membership within an unchanged boundary.
    if (trial % 4 === 0) items.push({ id: "timestamp", title: "Timestamp delivery", status: "closed", completed_at: "2026-11-07T09:30:00Z" });
    const context = { cwd: dir, pendingVersion: version, pendingTimestamp: "2026-11-07T10:00:00Z" };
    const options: GenerateChangelogOptions = { items, version, respectItemRelease: true, includeEmpty: true, dependencyUpdates: false, releaseWindows: resolveReleaseTagWindows(context) };
    const before = projection(options);
    const withoutEmpty = projection({ ...options, includeEmpty: false });
    const spelling = `${spellings[Math.floor(next() * spellings.length)]}${suffix}`;
    git("tag", spelling, target);
    const afterOptions = { ...options, releaseWindows: resolveReleaseTagWindows(context) };
    assert.ok(afterOptions.releaseWindows.find((window) => window.heading.startsWith(`${version} - `))?.until, `tag recognized trial ${trial}`);
    assert.deepEqual(projection(afterOptions), before, `seed 0x11072026 trial ${trial} ${spelling}`);
    assert.deepEqual(projection({ ...afterOptions, includeEmpty: false }), withoutEmpty, `nonempty trial ${trial}`);
    if (olderAliases[0]) {
      const alias = olderAliases[0].startsWith("v") ? olderAliases[0].slice(1) : `v${olderAliases[0]}`;
      addGitTagAlias(dir, alias, `${olderAliases[0]}^{commit}`);
    }
    // Publishing another spelling of either the newest or an older release cannot duplicate windows.
    addGitTagAlias(dir, `V2026.11.07${suffix}`, target);
    assert.deepEqual(projection({ ...options, releaseWindows: resolveReleaseTagWindows(context) }), before, `alias trial ${trial}`);
  }
});

test("empty Unreleased never consumes a release slot across visibility projections", () => {
  const item = { id: "shipped", title: "Delivered", status: "closed", release: "2026.11.7" };
  const options: GenerateChangelogOptions = { items: [item], includeEmpty: true, limit: 1, releaseWindows: [{ heading: "Unreleased", since: "2026-11-07T10:00:00Z", sinceExclusive: true }, { heading: "2026.11.7", releaseTag: "v2026.11.7" }] };
  assert.deepEqual(visibleChangelogItems(options), [item]);
  assert.equal(explainChangelogSelection(options).stage_counts.visible_items, 1);
  assert.equal(buildChangelogDocument(options).releases[0]!.heading, "2026.11.7");
  assert.doesNotMatch(createChangelog(options).markdown, /Unreleased/);
  const pending = { ...options, items: [{ ...item, release: undefined, completed_at: "2026-11-07T11:00:00Z" }] };
  assert.match(createChangelog(pending).markdown, /Unreleased/);
  assert.equal(createChangelog({ items: [], includeEmpty: true }).markdown, "# Changelog\n");
  assert.deepEqual(buildChangelogDocument({ items: [], includeEmpty: true }).releases, []);
  assert.equal(createChangelog({ items: [], groupBy: "release", includeEmpty: true }).markdown, "# Changelog\n");
});

test("alias fixture refuses every case-only duplicate while preserving portable aliases", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-stable-alias-fixture-"));
  t.after(() => removeGitFixture(dir));
  initGitFixture(dir);
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"], { cwd: dir, stdio: "pipe" });
  for (const name of ["v2026.11.07", "2026.11.7", "V2026.11.07-rc.1"]) {
    assert.equal(addGitTagAlias(dir, name, "HEAD"), true);
    for (const spelling of [name, name.toUpperCase(), name.toLowerCase()]) assert.equal(addGitTagAlias(dir, spelling, "HEAD"), false);
  }
  const tags = execFileSync("git", ["tag", "--list"], { cwd: dir, encoding: "utf8" }).trim().split("\n");
  assert.equal(tags.length, 3);
  assert.equal(new Set(tags.map((name) => name.toLowerCase())).size, tags.length);
});

test("mixed prerelease aliases preserve all release projections and the limited CLI check", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-stable-mixed-aliases-"));
  t.after(() => removeGitFixture(dir));
  initGitFixture(dir);
  const root = join(dir, ".agents/pm");
  await runInit("mixed", { path: root }, { defaults: true, agentGuidance: "skip" });
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: dirname(dir), GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "2026-11-07T10:00:00Z", GIT_COMMITTER_DATE: "2026-11-07T10:00:00Z", DO_NOT_TRACK: "1" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
  git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture");
  for (const name of ["v2026.11.7-2", "2026.11.7", "2026.11.7-rc.1"]) git("tag", name);
  const options = (): GenerateChangelogOptions => ({ items: ["2026.11.7-2", "2026.11.7", "2026.11.7-rc.1"].map((release) => ({ id: release, title: release, status: "closed", release })), respectItemRelease: true, includeEmpty: true, dependencyUpdates: false, releaseWindows: resolveReleaseTagWindows({ cwd: dir }) });
  const before = projection(options());
  assert.match(createChangelog({ ...options(), limit: 1 }).markdown, /## 2026\.11\.7-2/);
  const args = [resolve("src/cli.ts"), "--pm-root", root, "--pm-bin", resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--all-release-tags", "--include-empty", "--no-dependency-updates", "--limit", "1"];
  const cli = (...extra: string[]) => {
    const result = spawnSync(process.execPath, [...args, ...extra], { cwd: dir, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const formats = [["--stdout"], ["--format", "json"], ["--summary", "--format", "json"]];
  const output = formats.map((format) => cli(...format));
  cli("--output", "CHANGELOG.md", "--mode", "replace");
  for (const alias of ["2026.11.7-2", "v2026.11.07-2", "V2026.11.07", "v2026.11.07-rc.1"]) {
    assert.equal(addGitTagAlias(dir, alias, "HEAD"), true);
    assert.deepEqual(projection(options()), before, alias);
    assert.deepEqual(formats.map((format) => cli(...format)), output, alias);
    cli("--output", "CHANGELOG.md", "--mode", "replace", "--check");
  }
});

test("plain tracker checks empty versioned releases with no git executable", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-stable-no-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pmRoot = join(dir, ".agents", "pm");
  await runInit("pm", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  const noGit = join(dir, "no-git");
  mkdirSync(noGit);
  symlinkSync(process.execPath, join(noGit, "node"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2026.11.7" }));
  const cli = resolve("src/cli.ts");
  const pmBin = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const env = { PATH: noGit, GIT_CEILING_DIRECTORIES: dirname(dir), PM_GLOBAL_PATH: join(dir, "global"), DO_NOT_TRACK: "1" };
  const args = [cli, "--pm-root", pmRoot, "--pm-bin", pmBin, "--release-version-from-package", "--date-from-version", "--include-empty", "--mode", "replace", "--output", "CHANGELOG.md"];
  const generated = spawnSync(process.execPath, args, { cwd: dir, env, encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), "# Changelog\n\n## 2026.11.7 - 2026-11-07\n\nNo changes.\n");
  const checked = spawnSync(process.execPath, [...args, "--check"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  const tags = spawnSync(process.execPath, [...args, "--all-release-tags", "--check"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(tags.status, 1);
  assert.match(tags.stderr, /needs a git repository/);
  assert.match(tags.stderr, /Tracker-only generation and --milestones still work/);
});

test("CLI help states empty Unreleased policy", () => {
  assert.equal(cliTestSurface.parseArgs([]).releaseTagPattern, undefined);
  assert.equal(cliTestSurface.parseArgs(["--release-tag-pattern", "v*"]).releaseTagPattern, "v*");
  const result = spawnSync(process.execPath, [resolve("src/cli.ts"), "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--include-empty\s+Keep empty release sections; omit empty Unreleased/);
});


test("dependency-only Unreleased occupies the same limited slot in every projection", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-stable-dependency-slot-"));
  t.after(() => removeGitFixture(dir));
  initGitFixture(dir);
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
  /** Give each commit a known release boundary instead of consulting the clock. */
  const commit = (subject: string, timestamp: string) => execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", subject], { cwd: dir, env: { ...env, GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp }, stdio: "pipe" });
  commit("docs: release", "2026-11-07T10:00:00Z");
  git("tag", "v2026.11.7");
  commit("chore(deps): bump example from 1 to 2 (#7)", "2026-11-07T11:00:00Z");
  for (const includeEmpty of [true, false]) {
    const options: GenerateChangelogOptions = { items: [{ id: "old", title: "Hidden older delivery", status: "closed", release: "2026.11.7" }], version: "2026.11.7", includeEmpty, dependencyUpdates: true, gitCwd: dir, limit: 1, releaseWindows: resolveReleaseTagWindows({ cwd: dir }) };
    assert.match(createChangelog(options).markdown, /## Unreleased[\s\S]*### Dependencies/);
    assert.doesNotMatch(createChangelog(options).markdown, /Hidden older delivery/);
    assert.equal(buildChangelogDocument(options).releases[0]!.heading, "Unreleased");
    assert.deepEqual(visibleChangelogItems(options), []);
    assert.equal(explainChangelogSelection(options).stage_counts.visible_items, 0);
    assert.equal(explainChangelogSelection(options).excluded_counts.hidden_by_visibility, 1);
  }
});
