import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fixtureEnvironment, initGitFixture, removeGitFixture } from "./git-fixture.ts";

/** The five dependency bullets a published dependency-only section carries. */
const DEPENDENCY_BULLETS = [1, 2, 3, 4, 5].map((index) => `- Bump dep${index} from 1 to 2 (#${100 + index})`);

/** The generator renders dependency bullets newest-first, so the published
 * section lists them in that order — exactly as a committed, generated changelog
 * would. */
const PUBLISHED_DEPENDENCY_BULLETS = [...DEPENDENCY_BULLETS].reverse();

/** Extract one `## <version>` section's bytes, up to the next `## ` heading. */
function sectionOf(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}`);
  assert.ok(start !== -1, `missing section ${heading}`);
  const rest = markdown.slice(start);
  const end = rest.indexOf("\n## ", 1);
  return rest.slice(0, end === -1 ? undefined : end);
}

/** Build a repository whose published v2026.11.11 section is dependency-only.
 *
 * The tag window between v2026.11.10 and v2026.11.11 holds five Dependabot
 * commits, and the changelog committed at the tag renders them as the section's
 * only content — the exact shape a late closure from an in-progress sweep
 * lands in. The package version stays at the released 2026.11.11 until a test
 * moves it forward, so the leading window is `Unreleased` rather than a
 * fabricated pending heading. */
function publishedFixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "pmc-published-stability-"));
  t.after(() => removeGitFixture(dir));
  initGitFixture(dir);
  const env = {
    ...fixtureEnvironment(), PATH: process.env.PATH, TZ: "UTC",
    GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: "pipe" }).trim();
  const commit = (subject: string, date: string) => {
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", subject], {
      cwd: dir, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: "pipe",
    });
  };
  const writePackage = (version: string) => writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version }));
  writePackage("2026.11.10");
  git("add", "package.json");
  commit("Release fixture v2026.11.10", "2026-11-10T10:00:00Z");
  git("tag", "v2026.11.10");
  for (let index = 1; index <= 5; index++) {
    commit(`chore(deps): Bump dep${index} from 1 to 2 (#${100 + index})`, `2026-11-11T10:00:0${index}Z`);
  }
  writePackage("2026.11.11");
  writeFileSync(join(dir, "CHANGELOG.md"), `# Changelog\n\n## 2026.11.11 - 2026-11-11\n\n### Dependencies\n\n${PUBLISHED_DEPENDENCY_BULLETS.join("\n")}\n`);
  git("add", "CHANGELOG.md", "package.json");
  commit("Release fixture v2026.11.11", "2026-11-11T18:00:00Z");
  git("tag", "v2026.11.11");
  /** Replace the items input and return the CLI runner with the fleet flags. */
  const withItems = (items: unknown[]) => writeFileSync(join(dir, "items.json"), JSON.stringify({ items }));
  const cli = (...flags: string[]) => spawnSync(process.execPath, [
    resolve("src/cli.ts"), "--input", "items.json", "--all-release-tags",
    "--release-version-from-package", "--date-from-version", "--respect-item-release",
    ...flags,
  ], { cwd: dir, env, encoding: "utf8" });
  const read = () => readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  /** The published section's bytes exactly as committed at the tag. */
  const publishedSection = () => `## 2026.11.11 - 2026-11-11\n\n### Dependencies\n\n${PUBLISHED_DEPENDENCY_BULLETS.join("\n")}\n`;
  return { dir, git, commit, writePackage, withItems, cli, read, publishedSection };
}

test("a late-closed item in a published itemless section keeps its dependency bullets", (t) => {
  const f = publishedFixture(t);
  f.withItems([{
    id: "sweep-1", title: "Delivered in 2026.11.11, closed by the sweep", type: "Task",
    status: "closed", release: "2026.11.11", completed_at: "2026-11-14T12:00:00Z", updated_at: "2026-11-14T12:00:00Z",
  }]);
  const stale = f.cli("--mode", "replace", "--output", "CHANGELOG.md", "--check");
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /Changelog is out of date/);
  // The check's diff must only add the item's own rendering, never a removal.
  assert.doesNotMatch(stale.stderr, /^-Bump dep[1-5] from 1 to 2 \(#10[1-5]\)$/m);
  const generated = f.cli("--mode", "replace", "--output", "CHANGELOG.md");
  assert.equal(generated.status, 0, generated.stderr);
  const markdown = f.read();
  // The published section gains exactly its own bullet...
  assert.match(markdown, /## 2026\.11\.11 - 2026-11-11\n\n### Other\n\n- Delivered in 2026\.11\.11, closed by the sweep \(sweep-1\)\n\n### Dependencies\n\n/);
  // ...and keeps every published dependency bullet, removing nothing.
  for (const bullet of DEPENDENCY_BULLETS) assert.ok(markdown.includes(bullet), `kept ${bullet}`);
  const checked = f.cli("--mode", "replace", "--output", "CHANGELOG.md", "--check");
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stderr, /Changelog is up to date/);
});

test("an item closed inside the tag window keeps today's dependency behaviour", (t) => {
  const f = publishedFixture(t);
  f.withItems([{
    id: "in-window", title: "Closed inside the release window", type: "Task",
    status: "closed", release: "2026.11.11", completed_at: "2026-11-11T11:00:00Z", updated_at: "2026-11-11T11:00:00Z",
  }]);
  const generated = f.cli("--mode", "replace", "--output", "CHANGELOG.md");
  assert.equal(generated.status, 0, generated.stderr);
  const section = sectionOf(f.read(), "2026.11.11 - 2026-11-11");
  assert.match(section, /- Closed inside the release window \(in-window\)/);
  // An in-window item still drops the section's dependency notes, exactly as
  // before the published-section-stability rule: only work closed after the
  // tag is protected from rewriting the published section.
  assert.doesNotMatch(section, /### Dependencies/);
});

test("the closure timestamp, not a re-attributed completion, protects a published section", (t) => {
  const f = publishedFixture(t);
  // The pm-linear#223 shape: work delivered and merged during the release,
  // its completion re-attributed to the merge time (inside the window), but
  // the tracker only closed it in a later sweep (after the tag). The late
  // closure must keep the published dependency bullets.
  f.withItems([{
    id: "sweep-merge-time", title: "Merged in the release, closed by the sweep", type: "Chore",
    status: "closed", release: "2026.11.11",
    completed_at: "2026-11-11T10:00:03Z", closed_at: "2026-11-14T08:55:52Z", updated_at: "2026-11-14T10:11:05Z",
  }]);
  const generated = f.cli("--mode", "replace", "--output", "CHANGELOG.md");
  assert.equal(generated.status, 0, generated.stderr);
  const section = sectionOf(f.read(), "2026.11.11 - 2026-11-11");
  assert.match(section, /- Merged in the release, closed by the sweep \(sweep-merge-time\)/);
  assert.match(section, /### Dependencies/);
  for (const bullet of DEPENDENCY_BULLETS) assert.ok(section.includes(bullet), `kept ${bullet}`);
  // The mirror image pins closed_at as the deciding timestamp: a closure
  // recorded inside the window drops the notes even when a later, re-attributed
  // completion timestamp falls after the tag.
  f.withItems([{
    id: "closed-in-window", title: "Closed in the window, completed late", type: "Chore",
    status: "closed", release: "2026.11.11",
    completed_at: "2026-11-14T09:00:00Z", closed_at: "2026-11-11T11:00:00Z", updated_at: "2026-11-14T09:00:00Z",
  }]);
  const mirror = f.cli("--mode", "replace", "--output", "CHANGELOG.md");
  assert.equal(mirror.status, 0, mirror.stderr);
  const mirrorSection = sectionOf(f.read(), "2026.11.11 - 2026-11-11");
  assert.match(mirrorSection, /- Closed in the window, completed late \(closed-in-window\)/);
  assert.doesNotMatch(mirrorSection, /### Dependencies/);
});

test("a tagged package version renders the pending window as Unreleased (issue #349 acceptance)", (t) => {
  const f = publishedFixture(t);
  f.withItems([{
    id: "after-release", title: "Closed after the published release", type: "Task",
    status: "closed", completed_at: "2026-11-14T12:00:00Z", updated_at: "2026-11-14T12:00:00Z",
  }]);
  // package.json still holds the released, tagged 2026.11.11: the window after
  // the tag must be `## Unreleased`, not a second 2026.11.11 section.
  const tagged = f.cli("--mode", "replace", "--output", "CHANGELOG.md");
  assert.equal(tagged.status, 0, tagged.stderr);
  const markdown = f.read();
  assert.match(markdown, /## Unreleased\n\n### Other\n\n- Closed after the published release \(after-release\)/);
  assert.ok(!markdown.includes("## 2026.11.11 - 2026-11-11\n\n### Other"), "the published section gains nothing");
  // The published section keeps exactly its dependency line, and no duplicate
  // section for the tagged version appears.
  assert.equal(markdown.split("## 2026.11.11").length - 1, 1);
  assert.equal(sectionOf(markdown, "2026.11.11 - 2026-11-11").trimEnd(), `\n${f.publishedSection()}`.trimEnd());
  // Preparation variant: package.json moved to an untagged 2026.11.14, the
  // same item renders under the pending heading, and the released section's
  // bytes are unchanged between the two runs.
  f.writePackage("2026.11.14");
  f.git("add", "package.json");
  f.commit("Prepare fixture v2026.11.14", "2026-11-14T13:00:00Z");
  const prepared = f.cli("--mode", "replace", "--output", "CHANGELOG.md");
  assert.equal(prepared.status, 0, prepared.stderr);
  const preparedMarkdown = f.read();
  assert.match(preparedMarkdown, /## 2026\.11\.14 - 2026-11-14\n\n### Other\n\n- Closed after the published release \(after-release\)/);
  assert.doesNotMatch(preparedMarkdown, /## Unreleased/);
  assert.equal(sectionOf(preparedMarkdown, "2026.11.11 - 2026-11-11"), sectionOf(markdown, "2026.11.11 - 2026-11-11"));
});

test("--check stays stable across a release", (t) => {
  const f = publishedFixture(t);
  f.withItems([{
    id: "release-day", title: "Delivered for the pending release", type: "Task",
    status: "closed", completed_at: "2026-11-12T09:00:00Z", updated_at: "2026-11-12T09:00:00Z",
  }]);
  f.writePackage("2026.11.12");
  f.git("add", "package.json");
  f.commit("Prepare fixture v2026.11.12", "2026-11-12T10:00:00Z");
  // Preparation run: the untagged version names the pending window.
  const pending = f.cli("--mode", "replace", "--output", "CHANGELOG.md");
  assert.equal(pending.status, 0, pending.stderr);
  assert.match(f.read(), /## 2026\.11\.12 - 2026-11-12\n\n### Other\n\n- Delivered for the pending release \(release-day\)/);
  const before = f.read();
  f.git("add", "CHANGELOG.md", "package.json", "items.json");
  f.commit("Release fixture v2026.11.12", "2026-11-12T18:00:00Z");
  f.git("tag", "v2026.11.12");
  // Post-tag regeneration and check must be byte-identical: the tagged section
  // renders what the tag window produces, nothing more and nothing less.
  const regenerated = f.cli("--mode", "replace", "--output", "CHANGELOG.md");
  assert.equal(regenerated.status, 0, regenerated.stderr);
  assert.equal(f.read(), before);
  const checked = f.cli("--mode", "replace", "--output", "CHANGELOG.md", "--check");
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stderr, /Changelog is up to date/);
});
