import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { cliTestSurface } from "../src/cli.ts";
import { assertRequestedRelease, buildChangelogDocument, createChangelog, createChangelogSummary, MissingRequestedReleaseError } from "../src/index.ts";
import type { GenerateChangelogOptions } from "../src/index.ts";
import { initGitFixture, removeGitFixture } from "./git-fixture.ts";

/** Build a two-release repository with a tagged dependency bump and historical item. */
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "pm-itemless-"));
  t.after(() => removeGitFixture(dir));
  initGitFixture(dir);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: "pipe" }).trim();
  const commit = (subject: string, date = "2026-11-01T10:00:00Z") => execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "--allow-empty-message", "-m", subject], { cwd: dir, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: "pipe" });
  commit("initial", "2026-10-30T10:00:00Z"); git("tag", "v2026.10.30");
  commit("chore(deps): bump historical action (#10)", "2026-10-31T10:00:00Z"); git("tag", "v2026.10.31");
  const options: GenerateChangelogOptions = {
    items: [{ id: "old", title: "Historical delivery", status: "closed", type: "Task", release: "2026.10.31" }],
    version: "2026.11.1", gitCwd: dir, limit: 1, respectItemRelease: true,
    releaseWindows: [
      { heading: "2026.11.1 - 2026-11-01", releaseTag: "v2026.11.1", since: "2026-10-31T10:00:00Z", sinceExclusive: true },
      { heading: "2026.10.31 - 2026-10-31", releaseTag: "v2026.10.31", since: "2026-10-30T10:00:00Z", until: "2026-10-31T10:00:00Z" },
      { heading: "2026.10.30 - 2026-10-30", releaseTag: "v2026.10.30", until: "2026-10-30T10:00:00Z" },
    ],
  };
  const input = join(dir, "items.json");
  writeFileSync(input, JSON.stringify({ items: options.items }));
  const cli = (args: string[]) => spawnSync(process.execPath, [resolve("src/cli.ts"), "--input", input, "--version", "2026.11.1", "--date-from-version", "--stdout", "--limit", "1", "--respect-item-release", ...args], { cwd: dir, env, encoding: "utf8" });
  return { dir, commit, options, cli };
}

for (const subject of ["build(deps-dev): bump example from 1 to 2 (#11)", "ci: pin release workflow action (#205)"]) {
  test(`itemless pending default renders its own git notes: ${subject}`, (t) => {
    const { commit, options, cli } = fixture(t);
    commit(subject);
    const result = createChangelog(options);
    assert.doesNotThrow(() => assertRequestedRelease(options));
    assert.match(result.markdown, /^## 2026\.11\.1 - 2026-11-01$/m);
    assert.match(result.markdown, /### Dependencies/);
    assert.match(result.markdown, subject.startsWith("build") ? /Bump example from 1 to 2 \(#11\)/ : /ci: pin release workflow action \(\\#205\)/);
    assert.doesNotMatch(result.markdown, /Historical delivery|historical action|No changes/);
    assert.equal(result.itemCount, 0);
    assert.equal(buildChangelogDocument(options).releases[0]!.dependencies!.length, 1);
    assert.equal(createChangelogSummary(options).length, 1);
    for (const flags of [["--all-release-tags"], ["--since-previous-tag", "--until-release-tag"]]) {
      const rendered = cli(flags);
      assert.equal(rendered.status, 0, rendered.stderr);
      assert.match(rendered.stdout, /^## 2026\.11\.1 - 2026-11-01$/m);
      assert.match(rendered.stdout, /### Dependencies/);
      assert.doesNotMatch(rendered.stdout, /^## 2026\.10\.31/m);
      const optedOut = cli([...flags, "--no-dependency-updates"]);
      assert.equal(optedOut.status, 1, optedOut.stderr);
      assert.equal(optedOut.stdout, "");
      assert.equal(JSON.parse(optedOut.stderr).error.code, "MISSING_REQUESTED_RELEASE");
    }
  });
}

test("no pending commits retains empty behavior and typed extraction refusal", (t) => {
  const { options, cli } = fixture(t);
  assert.throws(() => assertRequestedRelease(options), MissingRequestedReleaseError);
  assert.doesNotMatch(createChangelog(options).markdown, /2026\.11\.1|Dependencies/);
  const result = cli(["--all-release-tags"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error.code, "MISSING_REQUESTED_RELEASE");
});

test("pending items and commits retain byte-identical item output unless opted in", (t) => {
  const { options, commit } = fixture(t);
  commit("build(deps): bump pending action (#12)");
  options.items.push({ id: "new", title: "Pending delivery", status: "closed", type: "Task", release: "2026.11.1" });
  assert.equal(createChangelog(options).markdown, createChangelog({ ...options, dependencyUpdates: false }).markdown);
  assert.doesNotMatch(createChangelog(options).markdown, /Dependencies/);
  assert.match(createChangelog({ ...options, dependencyUpdates: true }).markdown, /Bump pending action/);
});

test("historical windows stay byte-identical with pending and historical commit notes", (t) => {
  const { options, commit } = fixture(t);
  commit("ci: pin workflow (#205)");
  const all = { ...options, limit: undefined };
  const history = (markdown: string) => markdown.slice(markdown.indexOf("## 2026.10.31"));
  const historicalBefore = createChangelog({ ...all, dependencyUpdates: false }).markdown;
  assert.equal(history(createChangelog(all).markdown), history(historicalBefore));
  assert.match(createChangelog({ ...all, dependencyUpdates: true }).markdown, /Bump historical action/);
  assert.equal(createChangelog({ ...all, releaseWindows: all.releaseWindows!.slice(1) }).markdown, historicalBefore);
});

test("single pending fallback respects explicit cutoff and handles generic escaped subjects", (t) => {
  const { dir, commit } = fixture(t);
  commit("ci: pin [workflow](unsafe) (#205)");
  commit("later pin", "2026-11-02T10:00:00Z");
  const options: GenerateChangelogOptions = { items: [], version: "2026.11.1", pendingRelease: true, gitCwd: dir, dependencySinceRef: "v2026.10.31", dependencyCutoff: "2026-11-01T23:59:59Z" };
  assert.match(createChangelog(options).markdown, /ci: pin \\\[workflow/);
  assert.doesNotMatch(createChangelog(options).markdown, /later pin/);
  assert.equal(createChangelog({ ...options, dependencyUpdates: false }).markdown, "# Changelog\n");
  assert.equal(createChangelog({ ...options, pendingRelease: false }).markdown, "# Changelog\n");
  assert.equal(createChangelog({ ...options, groupBy: "release", version: undefined }).markdown, "# Changelog\n");
});

test("dependency opt-out parses and help describes pending-only defaults", () => {
  assert.equal(cliTestSurface.parseArgs(["--no-dependency-updates"]).dependencyUpdates, false);
  assert.equal(cliTestSurface.parseArgs([]).dependencyUpdates, undefined);
  const help = spawnSync(process.execPath, [resolve("src/cli.ts"), "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--no-dependency-updates/);
  assert.match(help.stdout, /itemless pending release gets a ### Dependencies/);
});


test("an empty git subject still gives a pending commit its recorded hash", (t) => {
  const { commit, options } = fixture(t);
  commit("");
  assert.match(createChangelog(options).markdown, /### Dependencies\n\n- Commit [a-f0-9]+\n/);
  assert.doesNotThrow(() => assertRequestedRelease(options));
});
