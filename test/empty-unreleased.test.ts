import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { mergeChangelog } from "../src/generator.ts";
import { initGitFixture, removeGitFixture } from "./git-fixture.ts";

/** Own a real release repository with deterministic dates and no inherited tracker. */
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "pm-empty-unreleased-"));
  t.after(() => removeGitFixture(dir));
  initGitFixture(dir);
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: dirname(dir),
    GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid", DO_NOT_TRACK: "1" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: "pipe" }).trim();
  const commit = (subject: string, date = "2026-11-10T10:00:00Z") => execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", subject], {
    cwd: dir, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: "pipe",
  });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2026.11.9" }));
  writeFileSync(join(dir, "items.json"), JSON.stringify({ items: [{ id: "old", title: "Older delivery", type: "Task", status: "closed", release: "2026.11.9" }] }));
  git("add", "package.json", "items.json");
  commit("Initial release", "2026-11-09T10:00:00Z");
  git("tag", "v2026.11.9");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2026.11.10" }));
  const cli = (...flags: string[]) => spawnSync(process.execPath, [resolve("src/cli.ts"), "--input", "items.json", "--all-release-tags",
    "--release-version-from-package", "--date-from-version", "--respect-item-release", "--output", "CHANGELOG.md", ...flags], { cwd: dir, env, encoding: "utf8" });
  const read = () => readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  return { dir, git, commit, cli, read };
}

for (const window of ["empty", "Dependabot-only", "released items"]) {
  test(`publication: ${window} write/commit/tag/check is stable with both include-empty settings`, (t) => {
    for (const includeEmpty of [false, true]) {
      const { dir, git, commit, cli, read } = fixture(t);
      const flags = ["--mode", "replace", ...(includeEmpty ? ["--include-empty"] : [])];
      if (window === "Dependabot-only") commit("chore(deps): bump example from 1 to 2 (#5)");
      if (window === "released items") writeFileSync(join(dir, "items.json"), JSON.stringify({ items: [
        { id: "old", title: "Older delivery", status: "closed", release: "2026.11.9" },
        { id: "current", title: "Delivered repair", type: "Issue", status: "closed", release: "2026.11.10", close_reason: "Repair selection" },
      ] }));
      const written = cli(...flags);
      assert.equal(written.status, 0, written.stderr);
      const before = read();
      assert.doesNotMatch(before, /^## Unreleased/m);
      if (window === "Dependabot-only") assert.match(before, /### Dependencies\n\n- Bump example from 1 to 2 \(#5\)/);
      if (window === "released items") assert.match(before, /## 2026\.11\.10 - 2026-11-10[\s\S]*Delivered repair/);
      if (window === "empty") assert.equal(before.includes("## 2026.11.10"), includeEmpty);
      git("add", "CHANGELOG.md", "package.json", "items.json");
      commit("Release fixture v2026.11.10");
      git("tag", "v2026.11.10");
      assert.equal(git("rev-parse", "HEAD"), git("rev-parse", "v2026.11.10"));
      const checked = cli(...flags, "--check");
      assert.equal(checked.status, 0, checked.stderr);
      assert.match(checked.stderr, /Changelog is up to date/);
      assert.equal(read(), before, "check must not rewrite the committed file");
      assert.equal(cli(...flags).status, 0);
      assert.equal(read(), before, "post-tag regeneration must preserve pre-tag bytes");
    }
  });
}

for (const mode of ["replace", "prepend", "stdout"]) {
  test(`tagged HEAD: ${mode} omits empty Unreleased and migrates legacy placeholders`, (t) => {
    const { dir, git, commit, cli, read } = fixture(t);
    const flags = ["--include-empty", "--mode", mode === "stdout" ? "replace" : mode];
    assert.equal(cli(...flags).status, 0);
    const expected = read();
    git("add", "CHANGELOG.md", "package.json");
    commit("Release fixture v2026.11.10");
    git("tag", "v2026.11.10");
    const legacy = expected.replace("# Changelog\n", "# Changelog\n\n## Unreleased\n\nNo changes.\n");
    writeFileSync(join(dir, "CHANGELOG.md"), legacy);
    if (mode === "stdout") {
      const printed = cli(...flags, "--stdout");
      assert.equal(printed.status, 0, printed.stderr);
      assert.equal(printed.stdout, expected);
      assert.equal(read(), legacy, "stdout must not modify the file");
    } else {
      const stale = cli(...flags, "--check");
      assert.equal(stale.status, 1, stale.stderr);
      assert.equal(read(), legacy, "failed check must be read-only");
      assert.equal(cli(...flags).status, 0);
      assert.equal(read(), expected);
      const checked = cli(...flags, "--check");
      assert.equal(checked.status, 0, checked.stderr);
    }
    assert.doesNotMatch(expected, /^## Unreleased/m);
  });
}

test("later unreleased item: retains nonempty notes in replace, prepend and stdout", (t) => {
  const { dir, git, commit, cli, read } = fixture(t);
  writeFileSync(join(dir, "items.json"), JSON.stringify({ items: [{ id: "current", title: "Released delivery", status: "closed", release: "2026.11.10" }] }));
  assert.equal(cli("--include-empty", "--mode", "replace").status, 0);
  git("add", "CHANGELOG.md", "package.json", "items.json");
  commit("Release fixture v2026.11.10");
  git("tag", "v2026.11.10");
  const tagged = cli("--include-empty", "--stdout");
  assert.equal(tagged.status, 0, tagged.stderr);
  assert.doesNotMatch(tagged.stdout, /^## Unreleased/m);
  writeFileSync(join(dir, "items.json"), JSON.stringify({ items: [
    { id: "current", title: "Released delivery", status: "closed", release: "2026.11.10" },
    { id: "old", title: "Older delivery", status: "closed", release: "2026.11.9" },
    { id: "later", title: "Later unreleased delivery", type: "Task", status: "closed", completed_at: "2026-11-11T10:00:00Z" },
  ] }));
  git("add", "items.json");
  commit("Deliver later work", "2026-11-11T10:00:00Z");
  for (const includeEmpty of [false, true]) for (const mode of ["replace", "prepend", "stdout"]) {
    const result = cli(...(includeEmpty ? ["--include-empty"] : []), ...(mode === "stdout" ? ["--stdout"] : ["--mode", mode]));
    assert.equal(result.status, 0, result.stderr);
    assert.match(mode === "stdout" ? result.stdout : read(), /## Unreleased\n\n### Other\n\n- Later unreleased delivery/);
  }
});

test("prepend cleanup: empty-only documents and normalized headings lose only empty placeholders", () => {
  for (const heading of ["Unreleased", "Unreleased - 2026-11-10", "[Unreleased]", "[Unreleased](https://example.invalid/compare)"]) {
    for (const body of ["", "No changes."]) {
      const merged = mergeChangelog(`# Changelog\n\n## ${heading}\n\n${body}\n`, "# Changelog\n");
      assert.deepEqual(merged, { markdown: "# Changelog\n", action: "replaced", changed: true });
      assert.equal(mergeChangelog(merged.markdown, "# Changelog\n").changed, false);
    }
    const meaningful = `# Changelog\n\n## ${heading}\n\n### Dependencies\n\n- Bump pending pin\n`;
    assert.equal(mergeChangelog(meaningful, "# Changelog\n").markdown, meaningful);
  }
  const prose = "# Changelog\n\n## Unreleased\n\nNo changes. More detail follows.\n";
  assert.equal(mergeChangelog(prose, "# Changelog\n").markdown, prose);
  const repeated = "# Changelog\n\n## Unreleased\n\nNo changes.\n\n## [Unreleased]\n\n## 1.0.0\n\nPreserved history.\n";
  assert.equal(mergeChangelog(repeated, "# Changelog\n").markdown, "# Changelog\n\n## 1.0.0\n\nPreserved history.\n");
});

test("later Dependabot entry: nonempty Unreleased survives every output mode", (t) => {
  const { dir, git, commit, cli, read } = fixture(t);
  writeFileSync(join(dir, "items.json"), JSON.stringify({ items: [{ id: "current", title: "Released delivery", status: "closed", release: "2026.11.10" }] }));
  assert.equal(cli("--include-empty", "--mode", "replace").status, 0);
  git("add", "CHANGELOG.md", "package.json", "items.json");
  commit("Release fixture v2026.11.10");
  git("tag", "v2026.11.10");
  const tagged = cli("--include-empty", "--stdout");
  assert.equal(tagged.status, 0, tagged.stderr);
  assert.doesNotMatch(tagged.stdout, /^## Unreleased/m);
  commit("chore(deps): bump later pin from 2 to 3 (#6)", "2026-11-11T10:00:00Z");
  for (const includeEmpty of [false, true]) for (const mode of ["replace", "prepend", "stdout"]) {
    const result = cli("--dependency-updates", ...(includeEmpty ? ["--include-empty"] : []), ...(mode === "stdout" ? ["--stdout"] : ["--mode", mode]));
    assert.equal(result.status, 0, result.stderr);
    assert.match(mode === "stdout" ? result.stdout : read(), /## Unreleased\n\n### Dependencies\n\n- Bump later pin from 2 to 3 \(#6\)/);
  }
});
