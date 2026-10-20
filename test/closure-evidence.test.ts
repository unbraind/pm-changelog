/** Evidence policy fixtures follow SDK/fleet rows; no source tracker is mutated. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import extension from "../src/extension.ts";
import { runCreate } from "@unbrained/pm-cli/sdk";
import {
  buildChangelogDocument, createChangelog, createChangelogSummary,
  explainChangelogSelection, mergeChangelog, readPmItems, suggestSemver,
} from "../src/index.ts";
import { countNonChangeClosures, isNonChangeClosure, needsNeutralClosure } from "../src/closure-policy.ts";
import type { PmItem } from "../src/index.ts";

const incident: PmItem = {
  id: "fixture-incident", title: "Historical workflow incident", type: "Issue", status: "closed",
  created_at: "2026-08-20T00:00:00Z", closed_at: "2026-08-27T00:00:00Z", completed_at: "2026-08-27T00:00:00Z",
  close_reason: "Closed on GitHub as completed on 2026-08-27T00:00:00Z",
};

const cases: { name: string; fields: Partial<PmItem>; category: string | null }[] = [
  { name: "factual GitHub completion", fields: {}, category: "Closed" },
  { name: "bare resolved state", fields: { resolution: "Resolved" }, category: "Closed" },
  { name: "resolved as completed state", fields: { resolution: "Resolved as completed" }, category: "Closed" },
  { name: "delivered issue is not a merged PR", fields: { actual_result: "Delivered issue #12" }, category: "Closed" },
  { name: "issue URL fragment is not a PR", fields: { links: [{ state: "merged", url: "https://github.com/example/project/issues/12#123" }] }, category: "Closed" },
  { name: "merged repository shorthand", fields: { actual_result: "Merged in example/project#121" }, category: "Fixed" },
  { name: "generic completion", fields: { close_reason: "Completed" }, category: "Closed" },
  { name: "title and tags are not evidence", fields: { title: "Fix security regression", tags: ["bug", "fixed", "security"] }, category: "Closed" },
  { name: "SDK linked changed file", fields: { files: [{ path: "src/parser.ts", scope: "project", note: "Changed parser" }] }, category: "Fixed" },
  { name: "SDK linked test command", fields: { tests: [{ command: "npm test", scope: "project", timeout_seconds: 240 }] }, category: "Fixed" },
  { name: "SDK linked test path", fields: { tests: [{ path: "test/parser.test.ts" }] }, category: "Fixed" },
  { name: "fix statement", fields: { close_reason: "Fixed exporter format validation; verified with npm test." }, category: "Fixed" },
  { name: "imperative repair statement", fields: { resolution: "Fix root handling with a bounded parser" }, category: "Fixed" },
  { name: "repair statement", fields: { resolution: "Repaired the parser" }, category: "Fixed" },
  { name: "correction statement", fields: { close_reason: "Corrected release placement" }, category: "Fixed" },
  { name: "resolved statement", fields: { resolution: "Resolved the root-dependent lookup" }, category: "Fixed" },
  { name: "fleet merged PR short reference", fields: { resolution: "Implemented and merged in #116 (2d52ed1)." }, category: "Fixed" },
  { name: "merged PR in actual result", fields: { actual_result: "Merged in PR #30 at bf091b7" }, category: "Fixed" },
  { name: "commit delivery", fields: { actual_result: "Delivered in commit abcdef1234567" }, category: "Fixed" },
  { name: "full PR link", fields: { resolution: "Merged in https://github.com/example/project/pull/12" }, category: "Fixed" },
  { name: "full commit link", fields: { actual_result: "Shipped https://github.com/example/project/commit/abcdef1" }, category: "Fixed" },
  { name: "string delivery link", fields: { links: ["Merged PR #12"] }, category: "Fixed" },
  { name: "structured merged link", fields: { links: [{ url: "https://github.com/example/project/pull/12", state: "merged" }] }, category: "Fixed" },
  { name: "structured delivered link", fields: { links: [{ url: "https://github.com/example/project/commit/abcdef1", relation: "delivered" }] }, category: "Fixed" },
  { name: "bare PR link is not merge evidence", fields: { resolution: "See https://github.com/example/project/pull/12", links: ["https://github.com/example/project/pull/12"] }, category: "Closed" },
  { name: "merged without reference", fields: { actual_result: "Merged elsewhere" }, category: "Closed" },
  { name: "issue link is not delivery", fields: { links: [{ state: "merged", url: "https://github.com/example/project/issues/12" }] }, category: "Closed" },
  { name: "negated fix", fields: { resolution: "Not fixed; investigation ended" }, category: "Closed" },
  { name: "unverified fix", fields: { close_reason: "Fixed? Unverified and pending" }, category: "Closed" },
  { name: "proposed PR", fields: { actual_result: "Will be merged in PR #12" }, category: "Closed" },
  { name: "unmerged PR", fields: { resolution: "Fixed in unmerged PR #12" }, category: "Closed" },
  { name: "malformed evidence", fields: { files: [null, 7, {}, { path: " " }], tests: [false, { command: "" }, { path: 42 }], links: [null, 42, {}, { state: "open" }] }, category: "Closed" },
  { name: "non-array evidence", fields: { files: "src/parser.ts", tests: {}, links: {} }, category: "Closed" },
  { name: "blank resolution", fields: { resolution: "  ", close_reason: "" }, category: "Closed" },
  { name: "missing fields", fields: { close_reason: undefined }, category: "Closed" },
  { name: "fix mentions duplicate symptom", fields: { close_reason: "Fixed duplicate label grouping with regression coverage" }, category: "Fixed" },
  { name: "fix mentions invalid input", fields: { close_reason: "Fixed invalid input handling" }, category: "Fixed" },
  ...["not planned", "not_planned", "not-planned", "duplicate", "invalid", "won't fix", "won’t fix", "wontfix", "wont_fix", "superseded"].map((reason) => ({ name: reason, fields: { close_reason: reason }, category: null })),
  { name: "GitHub non-planned timestamp", fields: { close_reason: "Closed on GitHub as not planned on 2026-08-27T00:00:00Z" }, category: null },
  { name: "duplicate prefix", fields: { close_reason: "Closed as duplicate of fixture-other" }, category: null },
  { name: "resolved duplicate", fields: { resolution: "Resolved as duplicate of fixture-other" }, category: null },
  { name: "fleet wontfix overrides other evidence", fields: { resolution: "Won't fix (not a code bug); regenerate CHANGELOG", close_reason: "Fixed previously", files: [{ path: "src/parser.ts" }] }, category: null },
  { name: "non-change feature", fields: { type: "Feature", close_reason: "Superseded by fixture-other" }, category: null },
  { name: "feature preserves section", fields: { type: "Feature" }, category: "Added" },
  { name: "task preserves section", fields: { type: "Task", title: "Update documentation" }, category: "Changed" },
  { name: "open issue keeps opt-in historical classification", fields: { status: "open" }, category: "Fixed" },
  ...["Bug", "Bugfix", "Defect", " ISSUE "].map((type) => ({ name: `closed ${type}`, fields: { type }, category: "Closed" })),
];

for (const fixture of cases) {
  test(`closure evidence: ${fixture.name}`, () => {
    const item = { ...incident, ...fixture.fields };
    const options = { items: [item], includeStatuses: [] };
    const generated = createChangelog(options);
    const document = buildChangelogDocument(options);
    const summary = createChangelogSummary(options);
    assert.equal(generated.excludedNonChangeCount, fixture.category === null ? 1 : 0);
    assert.equal(document.excluded_non_change_count, generated.excludedNonChangeCount);
    assert.equal(generated.itemCount, fixture.category === null ? 0 : 1);
    assert.equal(document.releases[0]?.sections[0]?.heading ?? null, fixture.category);
    assert.equal(summary[0]?.category ?? null, fixture.category);
    assert.equal(isNonChangeClosure(item), fixture.category === null);
    if (fixture.category === "Closed") {
      assert.equal(needsNeutralClosure(item), true);
      assert.equal(summary[0].title, `Closed: ${item.title}`);
      assert.doesNotMatch(generated.markdown, /### Fixed|### Security/);
      assert.equal(suggestSemver(options).counts.fix, 0);
    }
  });
}

test("historical incident repro stays neutral across projections and entry-from", () => {
  const options = { items: [incident], entryFrom: "close_reason" as const };
  assert.equal(createChangelog(options).markdown, "# Changelog\n\n## Unreleased\n\n### Closed\n\n- Closed: Historical workflow incident (fixture-incident)\n");
  assert.equal(buildChangelogDocument(options).releases[0].sections[0].items[0].title, "Closed: Historical workflow incident");
  assert.equal(createChangelogSummary(options)[0].title, "Closed: Historical workflow incident");
  assert.match(createChangelog({ ...options, conventional: true, emojiPrefix: true, sectionBy: "type" }).markdown, /Closed: Historical workflow incident/);
});

test("full changelog snapshot keeps release attribution, deterministic sorting and retained history", () => {
  const options = {
    items: [incident, { ...incident, id: "fixture-fixed", title: "Parser repair", resolution: "Fixed parser bounds" },
      { ...incident, id: "fixture-duplicate", close_reason: "Duplicate of fixture-fixed" },
      { ...incident, id: "fixture-feature", title: "Enable export", type: "Feature" },
      { ...incident, id: "fixture-task", title: "Update guide", type: "Task" }],
    releaseWindows: [{ heading: "Unreleased", since: "2026-09-01" }, { heading: "2026.8.28", until: "2026-09-01" }],
  };
  const snapshot = "# Changelog\n\n## 2026.8.28\n\n### Added\n\n- Enable export (fixture-feature)\n\n### Changed\n\n- Update guide (fixture-task)\n\n### Fixed\n\n- Parser repair (fixture-fixed)\n\n### Closed\n\n- Closed: Historical workflow incident (fixture-incident)\n";
  assert.equal(createChangelog(options).markdown, snapshot);
  assert.equal(createChangelog({ ...options, items: [...options.items].reverse() }).markdown, snapshot);
  assert.equal(countNonChangeClosures(options.items), 1);
  const report = explainChangelogSelection(options);
  assert.equal(report.excluded_counts.non_change, 1);
  assert.equal(report.stage_counts.visible_items, 4);
  const history = "# Changelog\n\n## 2026.8.1\n\n### Fixed\n\n- Original historical entry\n";
  assert.ok(mergeChangelog(history, snapshot).markdown.endsWith(history.slice("# Changelog\n\n".length)));
});

test("no-git stdin and real tracker input apply the evidence rule without a git executable", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-changelog-evidence-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const pmRoot = join(cwd, ".agents", "pm");
  const env = { ...process.env, PM_PATH: pmRoot, PM_GLOBAL_PATH: join(cwd, "global"), PM_AUTHOR: "fixture-agent", DO_NOT_TRACK: "1", GIT_CEILING_DIRECTORIES: dirname(cwd) };
  const pm = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const init = spawnSync(process.execPath, [pm, "init", "--yes", "--agent-guidance", "skip", "--no-merge-fence"], { cwd, env, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const created = await runCreate({ title: incident.title, type: "Issue", status: "closed", closeReason: incident.close_reason, createMode: "progressive" }, { path: pmRoot });
  await runCreate({ title: "Ignore duplicate", type: "Issue", status: "closed", closeReason: "Duplicate of fixture-other", createMode: "progressive" }, { path: pmRoot });
  await runCreate({ title: "Parser repair", type: "Issue", status: "closed", resolution: "Fixed parser bounds", closeReason: "Repair recorded", createMode: "progressive" }, { path: pmRoot });
  await runCreate({ title: "Linked file repair", type: "Issue", status: "closed", file: ["path=src/parser.ts,scope=project"], closeReason: "Recorded implementation", createMode: "progressive" }, { path: pmRoot });
  await runCreate({ title: "Linked test repair", type: "Issue", status: "closed", test: ["command=npm test,scope=project"], closeReason: "Recorded implementation", createMode: "progressive" }, { path: pmRoot });
  // An empty PATH proves the generation path cannot spawn git (or a global pm).
  const noGitEnv = { ...env, PATH: "" };
  const cli = resolve("dist/cli.js");
  const args = ["--stdout", "--json"];
  const stdin = spawnSync(process.execPath, [cli, "--stdin", ...args], { cwd, env: noGitEnv, encoding: "utf8", input: JSON.stringify({ items: [incident, { ...incident, id: "fixture-ignored", close_reason: "Not planned" }] }) });
  assert.equal(stdin.status, 0, stdin.stderr);
  const stdinReceipt = JSON.parse(stdin.stdout) as { markdown: string; excluded_non_change_count: number };
  assert.equal(stdinReceipt.excluded_non_change_count, 1);
  assert.match(stdinReceipt.markdown, /### Closed\n\n- Closed: Historical workflow incident/);
  assert.doesNotMatch(stdinReceipt.markdown, /### Fixed/);
  const tracker = spawnSync(process.execPath, [cli, "--pm-root", pmRoot, ...args], { cwd, env: noGitEnv, encoding: "utf8" });
  assert.equal(tracker.status, 0, tracker.stderr);
  const receipt = JSON.parse(tracker.stdout) as { markdown: string; excluded_non_change_count: number };
  assert.equal(receipt.excluded_non_change_count, 1);
  assert.match(receipt.markdown, /### Closed\n\n- Closed: Historical workflow incident/);
  assert.match(receipt.markdown, /### Fixed/);
  for (const title of ["Parser repair", "Linked file repair", "Linked test repair"]) assert.ok(receipt.markdown.includes(`- ${title} (`));
  assert.doesNotMatch(receipt.markdown, /Ignore duplicate/);
  for (const mode of [["--changelog-json"], ["--summary", "--format", "json"], ["--suggest-semver"], ["--suggest-semver", "--explain"]]) {
    const projection = spawnSync(process.execPath, [cli, "--stdin", ...mode], { cwd, env: noGitEnv, encoding: "utf8", input: JSON.stringify([incident, { ...incident, id: "fixture-ignored", close_reason: "Invalid" }]) });
    assert.equal(projection.status, 0, projection.stderr);
    assert.equal((JSON.parse(projection.stdout) as { excluded_non_change_count: number }).excluded_non_change_count, 1);
  }
  const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] });
  assert.deepEqual(activation.failed, []);
  for (const [command, options] of [
    ["changelog generate", { stdout: true }],
    ["changelog generate", { summary: true, format: "json" }],
    ["changelog generate", { "suggest-semver": true }],
    ["changelog export", { format: "json", "release-notes": true }],
  ] as const) {
    const run = await runRegisteredCommandForTest(activation.commands, { command, pmRoot, options });
    const rendered = run.result && typeof run.result === "object" && "output" in run.result && typeof run.result.output === "string"
      ? run.result.output : JSON.stringify(run.result);
    assert.match(rendered, /"excluded_non_change_count":\s*1/);
    assert.doesNotMatch(rendered, /Ignore duplicate/);
    if (!("suggest-semver" in options)) assert.match(rendered, /Closed: Historical workflow incident/);
  }
  const rows = readPmItems({ cwd, pmRoot, env: noGitEnv });
  assert.equal(rows.find((item) => item.id === created.item.id)?.close_reason, incident.close_reason);
});
