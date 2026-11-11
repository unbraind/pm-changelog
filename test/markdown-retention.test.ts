import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildChangelogDocument, createChangelog, createChangelogSummary, mergeChangelog, resolveReleaseTagWindows } from "../src/index.ts";
import { fixtureEnvironment, initGitFixture, removeGitFixture } from "./git-fixture.ts";

const generated = "# Changelog\n\n## 2.0.0\n\nNew delivery.\n";
const history = "## 1.0.0\n\nRetained delivery.\n";
const empty = "## Unreleased\n\nNo changes.\n\n";

test("property: fenced headings are opaque in cleanup, extraction, replacement, insertion and promotion", () => {
  let cases = 0;
  for (const marker of ["`", "~"]) for (const size of [3, 4, 9]) {
    for (const indent of ["", " ", "   "]) for (const eol of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
      const fence = marker.repeat(size);
      // Short, mismatched and suffixed fences cannot close the example.
      const example = [indent + fence + "markdown", "# Example title", "## Unreleased", "", "No changes.",
        "", "## 1.0.0", marker.repeat(size - 1), (marker === "`" ? "~" : "`").repeat(size),
        fence + " trailing prose", "## 9.0.0", indent + fence + marker + " \t"].join(eol);
      const prefix = `# Changelog\n\n${example}\n\n`;
      const clean = prefix + history;
      assert.equal(mergeChangelog(prefix + empty + history, "# Changelog\n").markdown, clean, "cleanup");
      assert.equal(mergeChangelog(clean, "# Changelog\n").markdown, clean, "no-op");
      assert.equal(mergeChangelog(clean, generated).markdown, prefix + generated.slice(13) + "\n" + history, "insertion");
      assert.equal(mergeChangelog(prefix + "## 2.0.0\n\nOld delivery.\n\n" + history, generated).markdown,
        prefix + generated.slice(13) + "\n" + history, "replacement");
      assert.equal(mergeChangelog(prefix + "## Unreleased\n\nPending delivery.\n\n" + history, generated).markdown,
        prefix + generated.slice(13) + "\n" + history, "promotion");
      const sectionWithExample = `# Changelog\n\n## 2.0.0\n\n${example}\n`;
      assert.equal(mergeChangelog("# Changelog\n", sectionWithExample).markdown, sectionWithExample, "generated extraction");
      const untitled = example + "\n\n" + history;
      assert.equal(mergeChangelog(untitled, generated).markdown,
        prefix + generated.slice(13) + "\n" + history, "title detection");
      cases++;
    }
  }
  assert.equal(cases, 90);
});

test("unclosed fences hide all remaining headings, while invalid openers do not hide releases", () => {
  for (const opening of ["```", "~~~", "   ````markdown", " ~~~~~text"]) {
    const existing = `# Changelog\n\n${opening}\n## Unreleased\n\nNo changes.\n\n## 1.0.0\n`;
    assert.equal(mergeChangelog(existing, "# Changelog\n").markdown, existing);
    assert.equal(mergeChangelog("# Changelog\n", existing).markdown, "# Changelog\n");
  }
  for (const opening of ["``", "~~", "    ```", "```bad`info"]) {
    const existing = `# Changelog\n\n${opening}\n\n${empty}${history}`;
    assert.equal(mergeChangelog(existing, "# Changelog\n").markdown, `# Changelog\n\n${opening}\n\n${history}`);
  }
});

test("property: retained indentation and hard-break spaces survive every Markdown splice", () => {
  for (const indent of ["    ", "\t", " \t  "]) for (const eol of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
    const code = `${indent}retained code  ${eol}${indent}second line  `;
    const prefix = code + "\n\n";
    assert.equal(mergeChangelog(prefix + empty + history, "# Changelog\n").markdown, prefix + history);
    assert.equal(mergeChangelog(prefix + empty, "# Changelog\n").markdown, code + "\n");
    const titled = `# Changelog\n\n${code}\n`;
    assert.equal(mergeChangelog(titled, generated).markdown, generated + "\n" + code + "\n", "after title");
    const untitled = code + "\n\n" + history;
    assert.equal(mergeChangelog(untitled, generated).markdown,
      `# Changelog\n\n${code}\n\n` + generated.slice(13) + "\n" + history, "ensure title");
    const before = `# Changelog\n\n${code}\n\n`;
    assert.equal(mergeChangelog(before + "## 2.0.0\n\nOld.\n\n" + history, generated).markdown,
      before + generated.slice(13) + "\n" + history, "before replacement");
    assert.equal(mergeChangelog(titled, "# Changelog\n").markdown, titled, "trailing hard break");
  }
});

test("committed fenced examples cannot authorize dependency-only releases in any projection", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-fenced-publication-"));
  t.after(() => removeGitFixture(dir));
  initGitFixture(dir);
  const env = { ...fixtureEnvironment(), GIT_AUTHOR_DATE: "2026-11-10T10:00:00Z", GIT_COMMITTER_DATE: "2026-11-10T10:00:00Z" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
  for (const [index, marker] of ["```", "~~~~"].entries()) {
    const version = `1.0.${index}`;
    writeFileSync(join(dir, "CHANGELOG.md"), `# Changelog\n\n${marker}markdown\n## ${version}\n\nNo changes.\n${marker}\n`);
    git("add", "CHANGELOG.md");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "chore(deps): bump example from 1 to 2 (#5)");
    git("tag", `v${version}`);
    const options = { items: [], gitCwd: dir, releaseWindows: resolveReleaseTagWindows({ cwd: dir }), includeEmpty: false };
    assert.equal(createChangelog(options).markdown, "# Changelog\n");
    assert.deepEqual(buildChangelogDocument(options).releases, []);
    assert.deepEqual(createChangelogSummary(options), []);
    const explicit = createChangelog({ ...options, dependencyUpdates: true }).markdown;
    assert.match(explicit, /### Dependencies/);
  }
});
