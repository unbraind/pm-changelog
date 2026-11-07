/** Real installed-package acceptance; inputs are synthetic caller projections. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "@toon-format/toon";
import { listAllComplete, runCreate, runInit } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import { auditChangelogClaims, buildChangelogDocument, createChangelog, createChangelogSummary, createReleaseMilestone, DirectoryReleaseMilestoneStore, formatClaimAudit, formatSummaryLine, resolveTrackerReleaseHistory } from "pm-changelog";
import type { PmItem } from "pm-changelog";
import extension from "pm-changelog/extension";

const cwd = process.argv[2]; assert.ok(cwd);
const root = join(cwd, ".agents/pm");
await runInit("pm", { path: root }, { defaults: true, agentGuidance: "skip" });
await runCreate({ title: "Native fixture", type: "Task", status: "closed", closeReason: "Delivered PR #12", createMode: "progressive" }, { path: root, author: "fixture" });
const native = (await listAllComplete({}, { pmRoot: root })).items[0] as PmItem;
const declaration = { before: "Allowed", after: "Refused", migrate: "Handle the refusal" };
const item = { ...native, title: "Declared\n behavior\r\nchanged", contract_change: null, metadata: { contract_change: declaration } };
const capture = await createReleaseMilestone(new DirectoryReleaseMilestoneStore(root), "1.0.0", { capturedAt: new Date().toISOString(), items: [item] });
const history = resolveTrackerReleaseHistory([capture], []);
const entries = createChangelogSummary({ ...history, entryFrom: "close_reason" });
assert.equal(entries[0].title, "Declared behavior changed");
assert.equal(formatSummaryLine(entries[0]).split("\n").length, 1);
const document = buildChangelogDocument(history);
assert.equal(document.releases[0].sections[0].items[0].title, entries[0].title);
assert.deepEqual(document.releases[0].sections[0].items[0].contract_change, declaration);
assert.match(createChangelog(history).markdown, /Allowed → Refused\. Migrate: Handle the refusal/);
const report = auditChangelogClaims(history);
assert.equal(report.claims[0].gaps.includes("migration"), false);
assert.equal(report.claims[0].gaps.includes("contract_change"), false);
/** TOON's documented JSON scalar columns preserve the complete claim arrays. */
function toonClaims(output: string): unknown {
  const decoded = decode(output) as { claims: { items: string; gaps: string }[] };
  return decoded.claims.map((row) => ({ ...row, items: JSON.parse(row.items), gaps: JSON.parse(row.gaps) }));
}
assert.deepEqual(toonClaims(formatClaimAudit(report, "toon")), report.claims);
const cli = join(dirname(fileURLToPath(import.meta.resolve("pm-changelog/package.json"))), "dist/cli.js");
/** Invoke the installed CLI with the same runtime as its SDK consumer. */
function run(args: string[], milestones = true): string {
  const result = spawnSync(process.execPath, [cli, ...args, ...(milestones ? ["--milestones"] : []), "--pm-root", root], { cwd, env: process.env, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
assert.equal(run(["--summary"]).trimEnd().split("\n").length, 1);
assert.equal(JSON.parse(run(["--summary", "--format", "json"])).entries[0].title, entries[0].title);
assert.deepEqual(JSON.parse(run(["--changelog-json"])).releases[0].sections[0].items[0].contract_change, declaration);
assert.match(run(["--stdout"]), /Allowed → Refused\. Migrate: Handle the refusal/);
assert.deepEqual(toonClaims(run(["audit"])), JSON.parse(run(["audit", "--format", "json"])).claims);
const input = join(cwd, "items.json"); writeFileSync(input, JSON.stringify([item]));
assert.equal(JSON.parse(run(["--input", input, "--summary", "--format", "json"], false)).entries[0].title, entries[0].title);
assert.deepEqual(JSON.parse(run(["--input", input, "--changelog-json"], false)).releases[0].sections[0].items[0].contract_change, declaration);
const activated = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] });
assert.deepEqual(activated.failed, []);
const plain = await runRegisteredCommandForTest(activated.commands, { command: "changelog generate", pmRoot: root, options: { milestones: true, summary: true } });
assert.equal((plain.result as { summary: string }).summary.split("\n").length, 1);
const json = await runRegisteredCommandForTest(activated.commands, { command: "changelog generate", pmRoot: root, options: { milestones: true, summary: true, format: "json" } });
assert.equal(JSON.parse((json.result as { output: string }).output).entries[0].title, entries[0].title);
for (const format of ["json", "toon"]) {
  const audit = await runRegisteredCommandForTest(activated.commands, { command: "changelog audit", pmRoot: root, global: { json: false }, options: { milestones: true, format: format === "json" ? "json" : "md" } });
  const output = (audit.result as { output: string }).output;
  if (format === "json") assert.deepEqual(JSON.parse(output), report);
  else assert.deepEqual(toonClaims(output), report.claims);
}
assert.equal(existsSync(join(cwd, ".git")), false);
console.log("packed projections passed: SDK, CLI, host, Markdown, JSON, TOON, non-git tracker");
