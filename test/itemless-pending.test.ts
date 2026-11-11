import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "2026-11-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-11-01T10:00:00Z" };
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
  return { dir, commit, options, cli, git, env, input };
}

/** Reproduce an itemless package release with only unassigned historical items. */
function capitalizedBumpFixture(t: { after: (fn: () => void) => void }) {
  const context = fixture(t);
  const { dir, git, commit, env, input } = context;
  writeFileSync(input, JSON.stringify({ items: [{ id: "old", title: "Historical delivery", status: "closed", type: "Task", completed_at: "2026-10-31T09:00:00Z", updated_at: "2026-10-31T09:00:00Z" }] }));
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## 2026.10.31 - 2026-10-31\n\n### Changed\n\n- Historical delivery (old)\n");
  git("add", "CHANGELOG.md");
  commit("docs: historical release notes", "2026-10-31T10:00:00Z");
  git("tag", "--force", "v2026.10.31");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2026.11.1" }));
  commit("Build(deps-dev): Bump the pm-toolchain group across 1 directory with 3 updates (#106)");
  commit("chore(deps): Bump ExampleSDK from vOne to vTwo (#107)");
  commit("CHORE(DEPS): BUMP OtherSDK from vOne to vTwo (#108)");
  commit("fix(deps): bumped excluded-past-tense from 1 to 2");
  commit("chore(deps): Bumps excluded-plural from 1 to 2");
  commit("chore(dependencies): Bump excluded-scope from 1 to 2");
  commit("Bump excluded-unscoped from 1 to 2");
  commit("chore(deps)!: Bump excluded-breaking from 1 to 2");
  const run = (args: string[]) => spawnSync(process.execPath, [resolve("src/cli.ts"), "--input", input,
    "--release-version-from-package", "--respect-item-release", "--date-from-version", ...args], { cwd: dir, env, encoding: "utf8" });
  return { ...context, run };
}

/** Verify exact description case and strict exclusions in CLI markdown. */
function assertCapitalizedDependencies(markdown: string): void {
  assert.match(markdown, /^## 2026\.11\.1 - 2026-11-01$/m);
  assert.match(markdown, /### Dependencies/);
  assert.match(markdown, /^- Bump the pm-toolchain group across 1 directory with 3 updates \(#106\)$/m);
  assert.match(markdown, /^- Bump ExampleSDK from vOne to vTwo \(#107\)$/m);
  assert.match(markdown, /^- BUMP OtherSDK from vOne to vTwo \(#108\)$/m);
  assert.doesNotMatch(markdown, /excluded-|MISSING_REQUESTED_RELEASE/);
}

test("capitalized dependency-only single-window CLI release accepts historical unassigned items", (t) => {
  const { run } = capitalizedBumpFixture(t);
  const result = run(["--since-previous-tag", "--until-release-tag", "--stdout"]);
  assert.equal(result.status, 0, result.stderr);
  assertCapitalizedDependencies(result.stdout);
  assert.doesNotMatch(result.stdout, /Historical delivery/);
});

test("capitalized dependency-only all-release-tags regeneration stays stable after tagging", (t) => {
  const { dir, run, git, commit } = capitalizedBumpFixture(t);
  const args = ["--all-release-tags", "--mode", "replace", "--output", "CHANGELOG.md"];
  const pending = run(args);
  assert.equal(pending.status, 0, pending.stderr);
  const before = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  assertCapitalizedDependencies(before);
  git("add", "CHANGELOG.md", "package.json");
  commit("Release pm-fixture v2026.11.1");
  git("tag", "v2026.11.1");
  const regenerated = run(args);
  assert.equal(regenerated.status, 0, regenerated.stderr);
  assert.equal(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), before);
  const checked = run([...args, "--check"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stderr, /Changelog is up to date/);
});

test("capitalized dependency-only CLI semver uses the same accepted single window", (t) => {
  const { run } = capitalizedBumpFixture(t);
  const flags = ["--since-previous-tag", "--until-release-tag"];
  const suggestion = run([...flags, "--suggest-semver"]);
  assert.equal(suggestion.status, 0, suggestion.stderr);
  // Dependency notes introduce no synthetic tracker item or item-based semver bump.
  assert.equal(JSON.parse(suggestion.stdout).bump, "none");
  const document = run([...flags, "--changelog-json"]);
  assert.equal(document.status, 0, document.stderr);
  const release = JSON.parse(document.stdout).releases[0];
  assert.equal(release.item_count, 0);
  assert.deepEqual(release.dependencies.map((entry: { description: string }) => entry.description), [
    "BUMP OtherSDK from vOne to vTwo", "Bump ExampleSDK from vOne to vTwo",
    "Bump the pm-toolchain group across 1 directory with 3 updates",
  ]);
});

test("capitalized dependency-only CLI check reports and repairs dependency note drift", (t) => {
  const { dir, run } = capitalizedBumpFixture(t);
  const args = ["--since-previous-tag", "--until-release-tag", "--mode", "replace", "--output", "CHANGELOG.md"];
  const drift = run([...args, "--check"]);
  assert.equal(drift.status, 1, drift.stderr);
  assert.match(drift.stderr, /Changelog is out of date/);
  assert.match(drift.stderr, /^\+### Dependencies$/m);
  assert.match(drift.stderr, /^\+- BUMP OtherSDK from vOne to vTwo \(#108\)$/m);
  assert.doesNotMatch(drift.stderr, /MISSING_REQUESTED_RELEASE/);
  const generated = run(args);
  assert.equal(generated.status, 0, generated.stderr);
  assertCapitalizedDependencies(readFileSync(join(dir, "CHANGELOG.md"), "utf8"));
  const checked = run([...args, "--check"]);
  assert.equal(checked.status, 0, checked.stderr);
});

for (const subject of ["build(deps-dev): bump example from 1 to 2 (#11)", "chore(deps): bump unbraind/pm-github/.github/workflows/pm-github-sync.yml from 2026.10.19 to 2026.10.28 (#205)"]) {
  test(`itemless pending default renders its own git notes: ${subject}`, (t) => {
    const { commit, options, cli } = fixture(t);
    commit(subject);
    const result = createChangelog(options);
    assert.doesNotThrow(() => assertRequestedRelease(options));
    assert.match(result.markdown, /^## 2026\.11\.1 - 2026-11-01$/m);
    assert.match(result.markdown, /### Dependencies/);
    assert.match(result.markdown, subject.startsWith("build") ? /Bump example from 1 to 2 \(#11\)/ : /Bump unbraind\/pm-github\/.* from 2026\.10\.19 to 2026\.10\.28 \(#205\)/);
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

test("single pending fallback respects explicit cutoff and escapes Dependabot descriptions", (t) => {
  const { dir, commit } = fixture(t);
  commit("chore(deps): bump [workflow](unsafe) (#205)");
  commit("chore(deps): bump later pin", "2026-11-02T10:00:00Z");
  const options: GenerateChangelogOptions = { items: [], version: "2026.11.1", pendingRelease: true, gitCwd: dir, dependencySinceRef: "v2026.10.31", dependencyCutoff: "2026-11-01T23:59:59Z" };
  assert.match(createChangelog(options).markdown, /Bump \\\[workflow/);
  assert.doesNotMatch(createChangelog(options).markdown, /later pin/);
  assert.equal(createChangelog({ ...options, dependencyUpdates: false }).markdown, "# Changelog\n");
  assert.equal(createChangelog({ ...options, pendingRelease: false }).markdown, "# Changelog\n");
  assert.equal(createChangelog({ ...options, groupBy: "release", version: undefined }).markdown, "# Changelog\n");
});

test("dependency opt-out parses and help describes immutable tagged defaults", () => {
  assert.equal(cliTestSurface.parseArgs(["--no-dependency-updates"]).dependencyUpdates, false);
  assert.equal(cliTestSurface.parseArgs([]).dependencyUpdates, undefined);
  const help = spawnSync(process.execPath, [resolve("src/cli.ts"), "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--no-dependency-updates/);
  assert.match(help.stdout, /Tagged itemless windows retain notes only if the changelog at that/);
});


test("empty subjects do not create notes or a section", (t) => {
  const { commit, options } = fixture(t);
  commit("");
  assert.doesNotMatch(createChangelog(options).markdown, /Dependencies|Commit [a-f0-9]+/);
  assert.throws(() => assertRequestedRelease(options), MissingRequestedReleaseError);
});

for (const shape of ["squash", "merge"]) {
  test(`fleet CLI transition remains up to date after a ${shape} release commit and tag`, (t) => {
    const { dir, git, commit, env, input } = fixture(t);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2026.11.1" }));
    commit("chore(deps): bump example from 1 to 2 (#5)");
    commit("docs: describe the release");
    const run = (args: string[]) => spawnSync(process.execPath, [resolve("src/cli.ts"), "--input", input,
      "--all-release-tags", "--date-from-version", "--mode", "replace", "--output", "CHANGELOG.md", ...args], { cwd: dir, env, encoding: "utf8" });
    const pending = run(["--version", "v2026.11.01"]);
    assert.equal(pending.status, 0, pending.stderr);
    const before = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    assert.match(before, /## 2026\.11\.1 - 2026-11-01/);
    assert.match(before, /Bump example from 1 to 2 \(#5\)/);
    assert.doesNotMatch(before, /docs:|Release/);
    const branch = git("branch", "--show-current");
    if (shape === "merge") git("checkout", "-b", "release-notes");
    git("add", "CHANGELOG.md", "package.json");
    commit("Release pm-fixture v2026.11.01");
    if (shape === "merge") {
      git("checkout", branch);
      commit("docs: parallel work");
      git("-c", "commit.gpgsign=false", "merge", "--no-ff", "release-notes", "-m", "Release pm-fixture v2026.11.01");
    }
    git("tag", "v2026.11.01");
    for (const later of [false, true]) {
      if (later) commit("docs: the next PR", "2026-11-02T10:00:00Z");
      const checked = run(["--release-version-from-package", "--check"]);
      assert.equal(checked.status, 0, checked.stderr);
      assert.match(checked.stderr, /Changelog is up to date/);
      assert.equal(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), before);
    }
  });
}

test("docs, a Dependabot-shaped merge and Release subjects leave pending extraction empty", (t) => {
  const { git, commit, options, cli } = fixture(t);
  const branch = git("branch", "--show-current");
  git("checkout", "-b", "docs-side");
  commit("docs: side documentation");
  git("checkout", branch);
  commit("Release pm-fixture v2026.11.01");
  git("-c", "commit.gpgsign=false", "merge", "--no-ff", "docs-side", "-m", "chore(deps): bump merge-only (#99)");
  assert.doesNotMatch(createChangelog(options).markdown, /2026\.11\.1|Dependencies/);
  assert.throws(() => assertRequestedRelease(options), MissingRequestedReleaseError);
  for (const flags of [["--all-release-tags"], ["--since-previous-tag", "--until-release-tag"]]) {
    const result = cli(flags);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "MISSING_REQUESTED_RELEASE");
  }
});

/** Give the fixture's requested window a real tag with an immutable changelog. */
function tagWindow(context: ReturnType<typeof fixture>, path: string, content: string): GenerateChangelogOptions {
  const { dir, git, commit, options } = context;
  commit("chore(deps): bump preserved from 1 to 2 (#5)");
  writeFileSync(join(dir, path), content);
  git("add", path);
  commit("Release pm-fixture v2026.11.01");
  git("tag", "v2026.11.01");
  return { ...options, releaseWindows: [
    { ...options.releaseWindows![0]!, releaseTag: "v2026.11.01", until: "2026-11-01T10:00:00Z" },
    ...options.releaseWindows!.slice(1),
  ] };
}

test("tagged itemless history without its committed heading stays byte-identical", (t) => {
  const context = fixture(t);
  const options = tagWindow(context, "CHANGELOG.md", "# Changelog\n\n## 2026.10.31\n");
  writeFileSync(join(context.dir, "CHANGELOG.md"), "## 2026.11.1 - 2026-11-01\n");
  const before = createChangelog({ ...options, dependencyUpdates: false }).markdown;
  assert.equal(createChangelog(options).markdown, before);
  assert.doesNotMatch(before, /2026\.11\.1|Dependencies/);
  assert.match(createChangelog({ ...options, dependencyUpdates: true }).markdown, /Bump preserved/);
});

for (const heading of ["## 2026.11.1", "## 2026.11.1 - 2026-11-01"]) {
  test(`tagged single and all-window defaults retain exact committed heading: ${heading}`, (t) => {
    const context = fixture(t);
    const options = tagWindow(context, "CHANGELOG.md", `# Changelog\r\n${heading}\r\n`);
    const single = { items: [], version: "2026.11.1", gitCwd: context.dir, dependencySinceRef: "v2026.10.31", dependencyUntilRef: "v2026.11.01" };
    for (const candidate of [options, single]) {
      assert.match(createChangelog(candidate).markdown, /Bump preserved/);
      assert.doesNotThrow(() => assertRequestedRelease(candidate));
      assert.doesNotMatch(createChangelog({ ...candidate, dependencyUpdates: false }).markdown, /Bump preserved/);
    }
    for (const flags of [["--all-release-tags"], ["--since-previous-tag", "--until-release-tag"]]) {
      const rendered = context.cli(flags);
      assert.equal(rendered.status, 0, rendered.stderr);
      assert.match(rendered.stdout, /Bump preserved/);
    }
  });
}

for (const heading of ["## 2026.11.10", "## 2026.11.1 extra", "### 2026.11.1 - date", "## [2026.11.1] - date"]) {
  test(`tagged default rejects a near-match heading: ${heading}`, (t) => {
    const context = fixture(t);
    const options = tagWindow(context, "CHANGELOG.md", `# Changelog\n${heading}\n`);
    assert.equal(createChangelog(options).markdown, createChangelog({ ...options, dependencyUpdates: false }).markdown);
  });
}

for (const pathKind of ["relative", "absolute", "subdirectory"]) {
  test(`SDK committed changelog path supports ${pathKind} paths`, (t) => {
    const context = fixture(t);
    mkdirSync(join(context.dir, "notes"));
    const options = tagWindow(context, "notes/RELEASES.md", "## 2026.11.1\n## 1.0.0-RC.1\n");
    const gitCwd = pathKind === "subdirectory" ? join(context.dir, "notes") : context.dir;
    const changelogPath = pathKind === "absolute" ? join(context.dir, "notes/RELEASES.md") : pathKind === "relative" ? "notes/RELEASES.md" : "RELEASES.md";
    assert.match(createChangelog({ ...options, gitCwd, changelogPath }).markdown, /Bump preserved/);
    context.git("tag", "v1.0.0-RC.1");
    const exactVersion = { ...options, version: "1.0.0-RC.1", gitCwd, changelogPath,
      releaseWindows: [{ ...options.releaseWindows![0]!, heading: "1.0.0-RC.1 - 2026-11-01", releaseTag: "v1.0.0-RC.1" }, ...options.releaseWindows!.slice(1)] };
    assert.match(createChangelog(exactVersion).markdown, /## 1\.0\.0-RC\.1 - 2026-11-01[\s\S]*Bump preserved/);
    assert.match(createChangelog({ items: [], version: "1.0.0-RC.1", gitCwd, changelogPath,
      dependencySinceRef: "v2026.10.31", dependencyUntilRef: "v1.0.0-RC.1" }).markdown, /Bump preserved/);
    assert.doesNotMatch(createChangelog(options).markdown, /Bump preserved/);
    assert.doesNotMatch(createChangelog({ ...options, gitCwd: join(context.dir, "absent") }).markdown, /Bump preserved/);
  });
}

test("CLI uses custom output from a nested git cwd; stdout always reads CHANGELOG.md", (t) => {
  const context = fixture(t);
  mkdirSync(join(context.dir, "notes"));
  tagWindow(context, "notes/RELEASES.md", "## 2026.11.1\n");
  const args = [resolve("src/cli.ts"), "--input", context.input, "--all-release-tags", "--version", "2026.11.1", "--date-from-version", "--output", "RELEASES.md", "--limit", "1"];
  const run = (extra: string[]) => spawnSync(process.execPath, [...args, ...extra], { cwd: join(context.dir, "notes"), env: context.env, encoding: "utf8" });
  const rendered = run(["--mode", "replace"]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(readFileSync(join(context.dir, "notes/RELEASES.md"), "utf8"), /Bump preserved/);
  const stdout = run(["--stdout"]);
  assert.equal(stdout.status, 1, stdout.stderr);
  assert.equal(stdout.stdout, "");
  assert.equal(JSON.parse(stdout.stderr).error.code, "MISSING_REQUESTED_RELEASE");
});

test("CLI resolves --output from the process cwd even when --pm-cwd names another directory", (t) => {
  const context = fixture(t);
  mkdirSync(join(context.dir, "notes"));
  tagWindow(context, "notes/RELEASES.md", "## 2026.11.1\n");
  const args = [resolve("src/cli.ts"), "--input", context.input, "--pm-cwd", context.dir, "--all-release-tags", "--version", "2026.11.1", "--date-from-version", "--output", "RELEASES.md", "--limit", "1", "--mode", "replace"];
  const rendered = spawnSync(process.execPath, args, { cwd: join(context.dir, "notes"), env: context.env, encoding: "utf8" });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(readFileSync(join(context.dir, "notes/RELEASES.md"), "utf8"), /Bump preserved/);
});

for (const state of ["pending", "tagged"]) {
  test(`full-file history check preserves a sectionless ${state} requested version`, (t) => {
    const context = fixture(t);
    const options = state === "tagged" ? tagWindow(context, "CHANGELOG.md", "# Changelog\n") : context.options;
    if (state === "pending") context.commit("docs: no dependency delivery");
    const expected = createChangelog({ ...options, limit: undefined, dependencyUpdates: false }).markdown;
    writeFileSync(join(context.dir, "CHANGELOG.md"), expected);
    const args = [resolve("src/cli.ts"), "--input", context.input, "--version", "2026.11.1", "--all-release-tags", "--date-from-version", "--mode", "replace", "--output", "CHANGELOG.md"];
    const run = (extra: string[]) => spawnSync(process.execPath, [...args, ...extra], { cwd: context.dir, env: context.env, encoding: "utf8" });
    const checked = run(["--check"]);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stderr, /Changelog is up to date/);
    assert.equal(run([]).status, 0);
    assert.equal(readFileSync(join(context.dir, "CHANGELOG.md"), "utf8"), expected);
    for (const subset of [["--stdout"], ["--limit", "1"], ["--since-version", "2026.10.31"]]) {
      const refused = run(["--check", ...subset]);
      assert.equal(refused.status, 1, refused.stderr);
      assert.equal(JSON.parse(refused.stderr).error.code, "MISSING_REQUESTED_RELEASE");
      assert.equal(readFileSync(join(context.dir, "CHANGELOG.md"), "utf8"), expected);
    }
  });
}
