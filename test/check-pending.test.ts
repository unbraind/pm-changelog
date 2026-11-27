import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { decode } from "@toon-format/toon";
import { runInit, runCreate } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import { cliTestSurface } from "../src/cli.ts";
import extension from "../src/extension.ts";
import { type RenderingVersion } from "../src/generator.ts";
import { buildChangelogDocument, createChangelog, createChangelogSummary, formatSummaryLine, mergeChangelog, writeChangelog } from "../src/index.ts";
import { resolveReleaseTagWindows } from "../src/release-context.ts";
import { fixtureEnvironment, initGitFixture, removeGitFixture } from "./git-fixture.ts";

const itemBase = "https://github.com/example/project/blob/main/.agents/pm";
const bracketForms = [["[", "]"], ["\\[", "\\]"], ["\\[", "]"], ["[", "\\]"]] as const;
const historicalMarkdownProfiles = ["2026.11.10", "2026.11.7", "2026.11.6"] as const satisfies readonly RenderingVersion[];
const modernMarkdownProfiles = ["2026.11.11", "2026.11.12"] as const satisfies readonly RenderingVersion[];

/** Two dated releases, a native tracker, and a committed changelog with no pending section. */
async function releaseFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pm-pending-check-"));
  t.after(() => removeGitFixture(dir));
  const root = join(dir, ".agents/pm");
  await runInit("pending", { path: root }, { defaults: true, agentGuidance: "skip" });
  initGitFixture(dir, ["-b", "main"]);
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid", DO_NOT_TRACK: "1" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: "pipe" }).trim();
  const commit = (subject: string, day: number) => {
    const date = `2026-11-${day}T12:00:00Z`;
    execFileSync("git", ["commit", "--allow-empty", "-m", subject], { cwd: dir, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: "pipe" });
  };
  const manifest = (version: string) => writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  const output = join(dir, "CHANGELOG.md");
  const read = () => readFileSync(output, "utf8");
  const cli = (...args: string[]) => spawnSync(process.execPath, [resolve("src/cli.ts"), "--pm-root", root,
    "--all-release-tags", "--dependency-updates", "--include-empty", "--release-version-from-package",
    "--respect-item-release", "--date-from-version", "--item-url-base", itemBase, ...args], { cwd: dir, env, encoding: "utf8" });
  const deliver = (id: string, day: number) => runCreate({ id, title: id, type: "Task", status: "closed",
    closeReason: "Implemented the change", completedAt: `2026-11-${day}T09:00:00Z`, createMode: "progressive" }, { path: root });
  manifest("2026.11.10");
  git("add", ".agents/pm", "package.json");
  commit("First release", 10);
  git("tag", "v2026.11.10");
  manifest("2026.11.11");
  await deliver("pending-shipped", 11);
  git("add", ".agents/pm", "package.json");
  commit("Second release", 11);
  git("tag", "v2026.11.11");
  const written = cli();
  assert.equal(written.status, 0, written.stderr);
  const published = read();
  assert.match(published, /## 2026\.11\.11 - 2026-11-11[\s\S]*pending-shipped[\s\S]*## 2026\.11\.10/);
  assert.doesNotMatch(published, /## Unreleased/);
  git("add", "CHANGELOG.md");
  commit("Record released history", 12);
  return { git, commit, manifest, output, read, cli, deliver, published };
}

/** Assert both the exit contract and the machine-readable advisory. */
function acceptsPending(result: { status: number | null; stdout: string; stderr: string }) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Drift classification: pending_only/);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.changed, false);
  assert.equal(receipt.classification, "pending_only");
}

test("two concurrent PRs keep their committed versioned file through merge and integration", async (t) => {
  const f = await releaseFixture(t);
  const check = () => acceptsPending(f.cli("--check", "--json"));
  f.git("checkout", "-b", "dependency");
  f.commit("chore(deps): bump example from 1 to 2", 13);
  check();
  f.git("checkout", "-b", "item", "main");
  await f.deliver("pending-delivery", 13);
  f.git("add", ".agents/pm");
  f.commit("Deliver tracker item", 13);
  check();
  f.git("checkout", "main");
  f.git("merge", "--ff-only", "dependency");
  f.git("merge", "--no-ff", "item", "-m", "Integrate second PR");
  check();
  const rendered = f.cli("--stdout");
  assert.match(rendered.stdout, /## Unreleased[\s\S]*pending-delivery/);
  assert.match(rendered.stdout, /- Bump example from 1 to 2/);
  assert.equal(f.read(), f.published);
  assert.equal(f.git("diff", "dependency", "item", "--", "CHANGELOG.md"), "");
  f.git("checkout", "item");
  f.git("merge", "--ff-only", "main");
  check();
  assert.equal(f.read(), f.published);
});

test("stale pending notes are advisory while both versioned sections and the preamble remain exact", async (t) => {
  const f = await releaseFixture(t);
  const stale = f.published.replace("## 2026.11.11", "## Unreleased\n\n- Stale\n\n## 2026.11.11");
  writeFileSync(f.output, stale);
  acceptsPending(f.cli("--check", "--json"));
  writeFileSync(f.output, f.published + "\n## Unreleased\n\n- Stale\n");
  acceptsPending(f.cli("--check", "--json"));
  writeFileSync(f.output, f.published + "\n\n## Unreleased\n\n- Stale\n");
  assert.equal(f.cli("--check").status, 1, "extra blank line in the preceding release remains visible");
  writeFileSync(f.output, stale);
  const strict = f.cli("--check-pending", "--json");
  assert.equal(strict.status, 1, strict.stderr);
  assert.equal(JSON.parse(strict.stdout).classification, "tracker_changed");
  assert.match(strict.stderr, /^-- Stale$/m);
  assert.equal(f.read(), stale);
  for (const [from, to] of [["# Changelog", "# Notes"], ["2026.11.10 -", "2026.11.9 -"],
    [" - 2026-11-11", " - 2026-11-12"], ["- pending-shipped", "- edited"], [itemBase, itemBase + "/wrong"]]) {
    const changed = stale.replace(from!, to!);
    assert.notEqual(changed, stale);
    writeFileSync(f.output, changed);
    const result = f.cli("--check", "--json");
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).classification, "tracker_changed");
    assert.equal(f.read(), changed);
  }
});

for (const [before, after] of [
  ["bump example", "bump example from 1 to 2 (#63)"],
  ["bump the actions group with 2 updates", "bump the actions group with 2 updates (#64)"],
]) {
  test(`squash merge changes an unreleased dependency subject: ${after}`, async (t) => {
    const f = await releaseFixture(t);
    f.git("checkout", "-b", "dependency");
    f.commit("chore(deps): " + before, 13);
    assert.equal(f.cli().status, 0);
    const branchNotes = f.read();
    assert.ok(branchNotes.includes("- B" + before.slice(1)));
    assert.doesNotMatch(branchNotes, /\/pull\/6[34]/);
    f.git("add", "CHANGELOG.md");
    f.commit("Record branch notes", 13);
    f.git("checkout", "main");
    f.git("merge", "--squash", "dependency");
    f.commit("chore(deps): " + after, 14);
    acceptsPending(f.cli("--check", "--json"));
    assert.equal(f.read(), branchNotes);
    f.manifest("2026.11.15");
    assert.equal(f.cli("--check").status, 1, "new release section is required");
    assert.equal(f.cli().status, 0);
    const released = f.read();
    assert.match(released, /^## 2026\.11\.15 - 2026-11-15$/m);
    assert.doesNotMatch(released, /^## Unreleased/m);
    const number = after.includes("#63") ? "63" : "64";
    const entry = "- B" + after.slice(1, after.indexOf(" (#")) + ` ([#${number}](https://github.com/example/project/pull/${number}))`;
    assert.ok(released.includes(entry), released);
    assert.equal(f.cli("--check").status, 0);
    writeFileSync(f.output, released.replace(entry, "- Stale release entry"));
    assert.equal(f.cli("--check").status, 1, "the finalized entry is exact");
  });
}

test("plain tracker SDK, standalone and registered host agree on a read-only pending advisory", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-plain-check-"));
  t.after(() => removeGitFixture(dir));
  const root = join(dir, ".agents/pm"), output = join(dir, "CHANGELOG.md");
  await runInit("plain", { path: root }, { defaults: true, agentGuidance: "skip" });
  const committed = "# Changelog\n\n## [Unreleased]\n\n- Stale\n";
  writeFileSync(output, committed);
  const options = { items: [], output, dependencyUpdates: false };
  const sdk = writeChangelog({ ...options, check: true });
  assert.equal(sdk.changed, false);
  assert.equal(sdk.classification, "pending_only");
  assert.equal(writeChangelog({ ...options, checkPending: true }).changed, true);
  writeFileSync(output, committed + "\n## Unreleased\n\nNo changes.\n");
  assert.equal(writeChangelog({ ...options, check: true }).classification, "pending_only", "adjacent stale sections share one separator");
  writeFileSync(output, committed);
  const stdout: string[] = [], stderr: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string) => { stdout.push(chunk); return true; });
  t.mock.method(console, "error", (message: string) => { stderr.push(message); });
  const flags = ["--pm-root", root, "--no-dependency-updates", "--output", output, "--check"];
  await cliTestSurface.main([...flags, "--json"]);
  assert.equal(JSON.parse(stdout.join("")).classification, sdk.classification);
  assert.match(stderr.pop()!, /pending_only/);
  stdout.length = 0;
  await cliTestSurface.main(flags);
  assert.deepEqual(stdout, []);
  assert.match(stderr.pop()!, /pending_only/);
  const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] });
  const optionsHost = { check: true, output, "no-dependency-updates": true };
  const host = await runRegisteredCommandForTest(activation.commands, { command: "changelog generate", pmRoot: root, options: optionsHost });
  const receipt = host.result as { changed: boolean; classification: string };
  assert.equal(receipt.changed, sdk.changed);
  assert.equal(receipt.classification, sdk.classification);
  assert.match(stderr.pop()!, /pending_only/);
  assert.equal(readFileSync(output, "utf8"), committed);
  const title = "Changelog\n\n```md\n## Unreleased\n- literal text\n```";
  writeFileSync(output, "# " + title.replace("literal text", "edited prose") + "\n");
  assert.equal(writeChangelog({ ...options, title, check: true }).changed, true, "fenced headings cannot hide preamble drift");
});

test("the project release note documents the new default and strict opt-in", () => {
  const notice = readFileSync(resolve("CHANGELOG.md"), "utf8").split("\n").find((line) => line.startsWith("> Release note (issue 384)"));
  assert.match(notice ?? "", /Unreleased.*pending_only.*--check-pending/);
});

test("checks agree with full regeneration across independent pending and released edits", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-check-projections-"));
  t.after(() => removeGitFixture(dir));
  const output = join(dir, "CHANGELOG.md");
  let seed = 384;
  for (let sample = 0; sample < 32; sample++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const old = { id: "shipped", status: "closed", title: "Released " + seed, release: "1.0.0" };
    const pending = { id: "next", status: "closed", title: "Pending " + seed };
    const options = { groupBy: "release" as const, output, dependencyUpdates: false };
    const written = writeChangelog({ ...options, items: [old, pending] }).markdown;
    const versionChanged = (seed & 1) === 1, pendingChanged = (seed & 2) === 2;
    const items = [{ ...old, title: versionChanged ? "Edited release" : old.title },
      { ...pending, title: pendingChanged ? "Edited pending" : pending.title }];
    const current = writeChangelog({ ...options, items, check: true });
    const strict = writeChangelog({ ...options, items, checkPending: true });
    assert.equal(readFileSync(output, "utf8"), written);
    const regenerated = writeChangelog({ ...options, items }).markdown;
    assert.equal(current.markdown, regenerated);
    assert.equal(strict.changed, written !== regenerated);
    assert.equal(current.changed, versionChanged);
    assert.equal(current.classification, pendingChanged && !versionChanged ? "pending_only" : undefined);
  }
});

test("selected rendering profile determines whether fenced headings delimit released sections", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-profile-headings-"));
  t.after(() => removeGitFixture(dir));
  const output = join(dir, "CHANGELOG.md");
  for (const fence of ["```", "~~~~"]) for (const [open, close] of bracketForms) {
    const committed = "# Changelog\n\n## " + open + "Unreleased" + close
      + "\n\n" + fence + "md\n## 1.0.0\n\n- Old release\n" + fence + "\n";
    writeFileSync(output, committed);
    for (const profile of historicalMarkdownProfiles) {
      for (const mode of ["prepend", "replace"] as const) {
        const options = mode === "prepend"
          ? { version: "1.0.0", items: [{ id: "fixed", status: "closed", title: "New release" }] }
          : { items: [] };
        const receipt = writeChangelog({ ...options, mode, output, dependencyUpdates: false, check: true }, profile);
        assert.equal(receipt.changed, true, profile + " " + mode);
        assert.equal(receipt.classification, undefined);
        assert.doesNotMatch(receipt.markdown, /Old release/);
        if (mode === "prepend") assert.match(receipt.markdown, /## 1\.0\.0\b[\s\S]*- New release/);
        else assert.equal(receipt.markdown, "# Changelog\n");
      }
    }
    for (const profile of modernMarkdownProfiles) {
      const options = { items: [], output, dependencyUpdates: false };
      const receipt = writeChangelog({ ...options, check: true }, profile);
      assert.equal(receipt.changed, false, profile);
      assert.equal(receipt.classification, "pending_only");
      assert.equal(writeChangelog({ ...options, checkPending: true }, profile).changed, true);
    }
    assert.equal(readFileSync(output, "utf8"), committed);
  }
});

test("selected rendering profile applies the prepend writer's terminal whitespace rule before checking", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-profile-whitespace-"));
  t.after(() => removeGitFixture(dir));
  const output = join(dir, "CHANGELOG.md");
  for (const [open, close] of bracketForms) for (const hardBreak of ["  ", "    "]) {
    const committed = "# Changelog\n\n## " + open + "Unreleased" + close
      + "\n\n- Old pending\n\n## 1.0.0\n\n- Retained release" + hardBreak + "\n";
    writeFileSync(output, committed);
    const options = { items: [{ id: "pending", status: "closed", title: "New pending" }],
      mode: "prepend" as const, output, dependencyUpdates: false };
    for (const profile of [...historicalMarkdownProfiles, ...modernMarkdownProfiles]) {
      const exact = writeChangelog({ ...options, checkPending: true }, profile);
      const receipt = writeChangelog({ ...options, check: true }, profile);
      const expectedEnding = modernMarkdownProfiles.some((modern) => modern === profile) ? hardBreak + "\n" : "\n";
      assert.equal(receipt.markdown, exact.markdown);
      assert.ok(receipt.markdown.endsWith("- Retained release" + expectedEnding), profile);
      assert.match(receipt.markdown, /New pending/);
      assert.equal(exact.changed, true);
      assert.equal(receipt.changed, false, profile);
      assert.equal(receipt.classification, "pending_only");
      assert.equal(readFileSync(output, "utf8"), committed);
    }
  }
});

test("escaped release labels share one identity across checks, cleanup, promotion and replacement", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-escaped-pending-"));
  t.after(() => removeGitFixture(dir));
  const output = join(dir, "CHANGELOG.md");
  const options = { items: [], output, dependencyUpdates: false };
  const title = "# Changelog\n";
  const history = "## 1.0.0\n\n- Old release\n";
  const release = "## 2.0.0 - 2026-11-27\n\n- Current release\n";
  for (const [open, close] of bracketForms) {
    for (const suffix of ["", " - 2026-11-27"]) {
      const pending = "## " + open + "uNrElEaSeD" + close + suffix + "\n\n";
      const committed = title + "\n" + pending + "- Pending work\n";
      writeFileSync(output, committed);
      const check = writeChangelog({ ...options, check: true });
      assert.equal(check.changed, false, pending);
      assert.equal(check.classification, "pending_only", pending);
      assert.equal(writeChangelog({ ...options, checkPending: true }).changed, true, pending);
      assert.equal(readFileSync(output, "utf8"), committed);
      const withHistory = title + "\n" + release + "\n" + pending + "- Pending work\n";
      writeFileSync(output, withHistory);
      assert.equal(writeChangelog({ ...options, check: true }).changed, true, "a released section must still match");
      assert.equal(mergeChangelog(title + "\n" + pending + "No changes.\n\n" + history, title).markdown, title + "\n" + history);
      assert.equal(mergeChangelog(committed + "\n" + history, title + "\n" + release).markdown, title + "\n" + release + "\n" + history);
      const decoratedRelease = "## " + open + "v02.0.0" + close + suffix + "\n\n- Stale release\n";
      assert.equal(mergeChangelog(title + "\n" + decoratedRelease + "\n" + history, title + "\n" + release).markdown,
        title + "\n" + release + "\n" + history);
    }
  }
  for (const malformed of [
    "\\[Unreleased", "Unreleased\\]", "\\\\[Unreleased\\]", "\\[Unreleased\\\\]", "\\[Unreleased\\\\\\]",
    "\\[Unreleased\\](https://example.invalid)", "[Unreleased\\](https://example.invalid)",
    "\\[Unreleased](https://example.invalid)", "\\[Unreleased\\] notes", "\\[Unreleased [detail]\\]", "\\[\\]",
  ]) {
    const committed = title + "\n## " + malformed + "\n\nNo changes.\n";
    writeFileSync(output, committed);
    assert.equal(writeChangelog({ ...options, check: true }).changed, true, malformed);
    assert.equal(mergeChangelog(committed, title).markdown, committed, malformed);
  }
});

test("escaped heading identity reaches structured versions and summary labels", () => {
  for (const [open, close] of bracketForms) {
    const pending = open + "Unreleased" + close;
    const version = open + "v02.0.0" + close + " - 2026-11-27";
    const options = { groupBy: "release" as const, dependencyUpdates: false,
      items: [{ id: "next", title: "Pending", status: "closed" }, { id: "previous", title: "Released", status: "closed", release: "2.0.0" }],
      releaseWindows: [{ heading: pending }, { heading: version, releaseTag: "v2.0.0" }],
      releaseMembership: new Map([["next", pending]]) };
    const document = buildChangelogDocument(options);
    assert.deepEqual(document.releases.map(({ heading, version }) => [heading, version]), [[pending, undefined], [version, "2.0.0"]]);
    assert.deepEqual(createChangelogSummary(options).map(formatSummaryLine), ["[Unreleased] Other: Pending (next)", "[2.0.0] Other: Released (previous)"]);
  }
});

test("tagged publication requires an exact heading across Markdown, document and summary generation", (t) => {
  const version = "1.0.0";
  for (const heading of [version, ...bracketForms.map(([open, close]) => open + version + close)]) {
    const dir = mkdtempSync(join(tmpdir(), "pm-escaped-publication-"));
    t.after(() => removeGitFixture(dir));
    initGitFixture(dir);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: fixtureEnvironment(), stdio: "pipe" });
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## " + heading + " - 2026-11-27\n\n- Published\n");
    git("add", "CHANGELOG.md");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
      "commit", "-m", "chore(deps): bump example from 1 to 2 (#6)");
    git("tag", "v" + version);
    const options = { items: [], gitCwd: dir, releaseWindows: resolveReleaseTagWindows({ cwd: dir }) };
    const markdown = createChangelog(options).markdown;
    const document = buildChangelogDocument(options);
    const summary = createChangelogSummary(options);
    if (heading === version) {
      assert.match(markdown, /^## 1\.0\.0[^\n]*\n\n### Dependencies/m);
      assert.equal(document.releases[0]?.dependencies?.length, 1);
      assert.deepEqual(summary.map(({ version, category }) => [version, category]), [[version, "Dependencies"]]);
    } else {
      assert.equal(markdown, "# Changelog\n", heading);
      assert.deepEqual(document.releases, []);
      assert.deepEqual(summary, []);
    }
  }
});

test("installed pm host emits the same pending verdict in JSON and TOON", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-host-check-"));
  t.after(() => removeGitFixture(dir));
  const root = join(dir, ".agents/pm");
  await runInit("pending", { path: root }, { defaults: true, agentGuidance: "skip" });
  const installed = join(root, "extensions/pm-changelog");
  mkdirSync(installed, { recursive: true });
  for (const file of ["dist", "package.json", "manifest.json"]) cpSync(resolve(file), join(installed, file), { recursive: true });
  symlinkSync(resolve("node_modules"), join(installed, "node_modules"), "junction");
  const output = join(dir, "CHANGELOG.md");
  for (const heading of ["Unreleased", "\\[Unreleased\\]"]) for (const json of [true, false]) {
    const committed = "# Changelog\n\n## " + heading + "\n\n- Pending work\n";
    writeFileSync(output, committed);
    const result = spawnSync(process.execPath, [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"),
      "--path", root, ...(json ? ["--json"] : []), "changelog", "generate", "--check",
      "--output", output, "--no-dependency-updates"], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const receipt = (json ? JSON.parse(result.stdout) : decode(result.stdout)) as { changed: boolean; classification?: string };
    assert.equal(receipt.changed, false);
    assert.equal(receipt.classification, "pending_only");
    assert.match(result.stderr, /Drift classification: pending_only/);
    assert.equal(readFileSync(output, "utf8"), committed);
  }
});
