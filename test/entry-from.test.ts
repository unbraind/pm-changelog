import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { runCreate, runUpdate } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import extension from "../src/extension.ts";
import { cliTestSurface } from "../src/cli.ts";
import {
  buildChangelogDocument, createChangelogSummary, generateChangelog,
  lintChangelogEntries, parseChangelogEntryFrom, readPmItems,
} from "../src/index.ts";

const DEFECT = "The comment-sync test is root-sensitive";
const RESOLUTION = "Make the comment-sync test independent of the root directory";

/** Initialize a real isolated tracker and expose the built standalone command.
 * Cleanup and global-root isolation keep all lifecycle writes disposable. */
function tracker(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pm-changelog-entry-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const pmRoot = join(cwd, ".agents", "pm");
  const env = { ...process.env, PM_PATH: pmRoot, PM_GLOBAL_PATH: join(cwd, "global"), PM_AUTHOR: "test-agent", DO_NOT_TRACK: "1" };
  const pmCli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const cli = resolve("dist/cli.js");
  const initialized = spawnSync(process.execPath, [pmCli, "init", "--yes", "--agent-guidance", "skip"], { cwd, env, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  return {
    cwd, pmRoot, env,
    /** Invoke built package code against this tracker with complete read flags. */
    changelog(args: string[]) {
      return spawnSync(process.execPath, [cli, "--pm-root", pmRoot, "--pm-arg=--output-budget", "--pm-arg=unbounded", "--pm-arg=--output-limit", "--pm-arg=unbounded", ...args], { cwd, env, encoding: "utf8" });
    },
  };
}

/** Model legacy tracker documents with blank or absent resolution fields after
 * a real SDK close. This fixture edit bypasses today's non-empty update policy;
 * all package reads still parse the real stored tracker through pm. */
function setLegacyCloseReason(pmRoot: string, id: string, value: string | undefined): void {
  const path = join(pmRoot, "issues", `${id}.toon`);
  const source = readFileSync(path, "utf8");
  assert.match(source, /^close_reason:.*$/m);
  writeFileSync(path, source.replace(/^close_reason:.*\n/m, value === undefined ? "" : `close_reason: ${JSON.stringify(value)}\n`));
}

test("built entry-from renders resolution, preserves default bytes and checks the same choice", async (t) => {
  const fixture = tracker(t);
  const global = { path: fixture.pmRoot };
  const created = await runCreate({ title: DEFECT, type: "Issue", createMode: "progressive", status: "closed", closeReason: RESOLUTION }, global);
  assert.ok(typeof created.item.id === "string");
  const defaultRun = fixture.changelog(["--stdout"]);
  assert.equal(defaultRun.status, 0, defaultRun.stderr);
  assert.equal(defaultRun.stdout, `# Changelog\n\n## Unreleased\n\n### Fixed\n\n- ${DEFECT} (${created.item.id})\n`);
  const generated = fixture.changelog(["--entry-from=close_reason"]);
  assert.equal(generated.status, 0, generated.stderr);
  const markdown = readFileSync(join(fixture.cwd, "CHANGELOG.md"), "utf8");
  assert.match(markdown, new RegExp(`### Fixed\\n\\n- ${RESOLUTION}`));
  assert.doesNotMatch(markdown, /root-sensitive/);
  const checked = fixture.changelog(["--entry-from", "close_reason", "--check", "--json"]);
  assert.equal(checked.status, 0, checked.stderr);
  const captured: string[] = [];
  const stdout = t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { captured.push(String(chunk)); return true; });
  try {
    await cliTestSurface.main(["--pm-root", fixture.pmRoot, "--pm-cwd", fixture.cwd, "--output", join(fixture.cwd, "CHANGELOG.md"), "--entry-from", "close_reason", "--check", "--json"]);
  } finally { stdout.mock.restore(); }
  assert.match(captured.join(""), /"entry_from":"close_reason"/);
  const receipt: unknown = JSON.parse(checked.stdout);
  assert.ok(receipt && typeof receipt === "object" && "entry_from" in receipt && receipt.entry_from === "close_reason");
  assert.equal(fixture.changelog(["--check", "--no-check-diff"]).status, 1);
  const summary = fixture.changelog(["--summary", "--entry-from", "close_reason"]);
  assert.match(summary.stdout, new RegExp(RESOLUTION));
  const document = fixture.changelog(["--changelog-json", "--entry-from", "close_reason"]);
  assert.match(document.stdout, /"entry_from": "close_reason"/);
  assert.doesNotMatch(document.stdout, /root-sensitive/);
  const items = readPmItems({ cwd: fixture.cwd, pmRoot: fixture.pmRoot, env: fixture.env, pmArgs: ["--output-budget", "unbounded", "--output-limit", "unbounded"] });
  assert.equal(items[0].title, DEFECT);
  assert.equal(items[0].close_reason, RESOLUTION);
  assert.equal(fixture.changelog(["--entry-from", "description"]).status, 1);
});

test("real tracker fallbacks, escaping, projections and filtering preserve entry semantics", async (t) => {
  const fixture = tracker(t);
  const global = { path: fixture.pmRoot };
  const fixed = await runCreate({ title: DEFECT, type: "Issue", status: "closed", closeReason: RESOLUTION, createMode: "progressive" }, global);
  assert.ok(typeof fixed.item.id === "string");
  await runCreate({ title: "The ignored command fails", type: "Issue", status: "closed", closeReason: "Hidden resolution", tags: "changelog:ignore", createMode: "progressive" }, global);
  await runCreate({ title: "The open command fails", type: "Issue", createMode: "progressive" }, global);
  const read = () => readPmItems({ cwd: fixture.cwd, pmRoot: fixture.pmRoot, env: fixture.env, pmArgs: ["--output-budget", "unbounded", "--output-limit", "unbounded"] });
  const options = { items: read(), entryFrom: "close_reason" as const, excludeTags: ["changelog:ignore"] };
  assert.deepEqual(createChangelogSummary(options).map((entry) => entry.title), [RESOLUTION]);
  assert.equal(buildChangelogDocument(options).releases[0].sections[0].items[0].title, RESOLUTION);
  assert.doesNotMatch(generateChangelog(options), /Hidden resolution|open command/);
  assert.deepEqual(lintChangelogEntries(options), []);
  for (const value of ["", " \n\t "]) {
    setLegacyCloseReason(fixture.pmRoot, fixed.item.id, value);
    options.items = read();
    assert.equal(generateChangelog(options), generateChangelog({ ...options, entryFrom: undefined }));
    assert.equal(createChangelogSummary(options)[0].title, DEFECT);
    assert.equal(lintChangelogEntries(options).length, 1);
  }
  await runUpdate(fixed.item.id, { closeReason: "Fix `--sync` with *safe* snake_case\nacross roots" }, global);
  options.items = read();
  assert.match(generateChangelog(options), /Fix `--sync` with \\\*safe\\\* snake_case across roots/);
  const item = options.items.find((entry) => entry.id === fixed.item.id)!;
  assert.equal(generateChangelog({ items: [{ ...item, close_reason: undefined }], entryFrom: "close_reason" }), generateChangelog({ items: [item] }));
  // Malformed caller JSON follows the same fallback; the SDK itself is never mocked.
  const malformed = { ...item, close_reason: 42 };
  assert.equal(generateChangelog({ items: [malformed as unknown as typeof item], entryFrom: "close_reason" }), generateChangelog({ items: [item] }));
  assert.equal(parseChangelogEntryFrom("title"), "title");
  assert.throws(() => parseChangelogEntryFrom("body"), /--entry-from/);
  const breaking = buildChangelogDocument({ items: [{ ...item, breaking: true }], entryFrom: "close_reason", breakingChanges: true });
  assert.equal(breaking.releases[0].breaking_changes?.[0].title, "Fix `--sync` with *safe* snake_case across roots");
});

test("check warns without drift, excludes hidden entries, and recovery clears warning", async (t) => {
  const fixture = tracker(t);
  const global = { path: fixture.pmRoot };
  const created = await runCreate({ title: DEFECT, type: "Issue", status: "closed", closeReason: "Temporary fixture reason", createMode: "progressive" }, global);
  assert.ok(typeof created.item.id === "string");
  setLegacyCloseReason(fixture.pmRoot, created.item.id, undefined);
  assert.equal(fixture.changelog([]).status, 0);
  const checked = fixture.changelog(["--check"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stderr, new RegExp(`Warning: defect_title: ${created.item.id}`));
  assert.match(checked.stderr, new RegExp(`pm update ${created.item.id} --close-reason`));
  assert.match(checked.stderr, /--entry-from close_reason/);
  const warnings: string[] = [];
  const stderr = t.mock.method(console, "error", (...values: unknown[]) => { warnings.push(values.map(String).join(" ")); });
  try {
    await cliTestSurface.main(["--pm-root", fixture.pmRoot, "--pm-cwd", fixture.cwd, "--output", join(fixture.cwd, "CHANGELOG.md"), "--check"]);
  } finally { stderr.mock.restore(); }
  assert.match(warnings.join(" "), /Warning: defect_title:/);
  assert.doesNotMatch(fixture.changelog(["--stdout"]).stderr, /defect_title/);
  for (const args of [["--status", "open"], ["--since", "2099-01-01"], ["--section-by", "type"], ["--exclude-tag", "skip"]]) {
    if (args.includes("skip")) await runUpdate(created.item.id, { tags: "skip" }, global);
    assert.doesNotMatch(fixture.changelog(["--check", "--stdout", ...args]).stderr, /defect_title/);
  }
  const items = readPmItems({ cwd: fixture.cwd, pmRoot: fixture.pmRoot, env: fixture.env, pmArgs: ["--output-budget", "unbounded", "--output-limit", "unbounded"] });
  const item = items[0];
  assert.deepEqual(lintChangelogEntries({ items, sectionBy: "type" }), []);
  assert.deepEqual(lintChangelogEntries({ items: [{ ...item, title: "Fix the comment-sync test that fails across roots" }] }), []);
  assert.deepEqual(lintChangelogEntries({ items: [{ ...item, title: "Correct root handling" }, { ...item, type: "Feature" }, { ...item, status: "open" }], includeStatuses: [] }), []);
  assert.match(lintChangelogEntries({ items: [{ ...item, id: undefined }] })[0], /pm update <id>/);
  const windows = [{ heading: "2.0.0", since: "2000-01-01" }, { heading: "1.0.0", since: "2000-01-01" }];
  assert.equal(lintChangelogEntries({ items, releaseWindows: windows }).length, 1);
  assert.deepEqual(lintChangelogEntries({ items, releaseWindows: windows, sinceVersion: "3.0.0" }), []);
  await runUpdate(created.item.id, { closeReason: RESOLUTION }, global);
  const recovery = fixture.changelog(["--stdout", "--check", "--entry-from", "close_reason", "--conventional", "--emoji-prefix"]);
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.doesNotMatch(recovery.stderr, /defect_title/);
  assert.match(recovery.stdout, /### 🐛 Bug Fixes/);
  assert.match(recovery.stdout, new RegExp(RESOLUTION));
});

test("real extension generate, export and check accept entry-from and reject invalid sources", async (t) => {
  const fixture = tracker(t);
  const global = { path: fixture.pmRoot };
  const created = await runCreate({ title: DEFECT, type: "Issue", status: "closed", closeReason: RESOLUTION, createMode: "progressive" }, global);
  assert.ok(typeof created.item.id === "string");
  const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] });
  assert.deepEqual(activation.failed, []);
  for (const command of ["changelog generate", "changelog export"]) {
    const run = await runRegisteredCommandForTest(activation.commands, { command, pmRoot: fixture.pmRoot, options: { stdout: true, "entry-from": "close_reason" } });
    assert.match(JSON.stringify(run.result), new RegExp(RESOLUTION));
    assert.doesNotMatch(JSON.stringify(run.result), /root-sensitive/);
    const defaults = await runRegisteredCommandForTest(activation.commands, { command, pmRoot: fixture.pmRoot, options: { stdout: true } });
    assert.match(JSON.stringify(defaults.result), /root-sensitive/);
    await assert.rejects(runRegisteredCommandForTest(activation.commands, { command, pmRoot: fixture.pmRoot, options: { "entry-from": "description" } }), /--entry-from/);
  }
  const output = join(fixture.cwd, "extension.md");
  await runRegisteredCommandForTest(activation.commands, { command: "changelog generate", pmRoot: fixture.pmRoot, options: { output, "entry-from": "close_reason" } });
  const checked = await runRegisteredCommandForTest(activation.commands, { command: "changelog generate", pmRoot: fixture.pmRoot, options: { output, check: true, "entry-from": "close_reason" } });
  assert.match(JSON.stringify(checked.result), /"changed":false/);
  setLegacyCloseReason(fixture.pmRoot, created.item.id, undefined);
  // Real check executes lint even when it reports file drift.
  await assert.rejects(runRegisteredCommandForTest(activation.commands, { command: "changelog generate", pmRoot: fixture.pmRoot, options: { output, check: true } }), /out of date/);
});
