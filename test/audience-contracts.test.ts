import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { listAllComplete, runCreate, runInit, runWithActiveExtensions } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, runRegisteredCommandForTest, decodeToon as decode } from "@unbrained/pm-cli/sdk/testing";
import { AudienceContractError, CHANGE_AUDIENCES, buildAudienceContracts, formatAudienceContracts, parseChangeAudience, readAudienceContracts } from "../src/index.ts";
import type { PmItem } from "../src/index.ts";
import { runAudienceContractsCli, runAudienceContractsCommand } from "../src/audience-command.ts";
import { cliTestSurface } from "../src/cli.ts";
import extension from "../src/extension.ts";

const fixtures = resolve("test/fixtures/audience-contracts");
const mixed = JSON.parse(readFileSync(join(fixtures, "items.json"), "utf8")) as PmItem[];

/** Assert the stable expected-error discriminator and actionable recovery. */
function refusal(code: AudienceContractError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof AudienceContractError && error.code === code && error.exitCode !== 0 && !!error.remedy;
}

test("control-character facets round-trip through the pm TOON decoder", () => {
  const text = 'Form feed:\f backspace:\b NUL:\u0000 unit separator:\u001f quotes:" backslash:\\ newline:\n carriage return:\r tab:\t';
  const report = buildAudienceContracts({ audience: "operator", items: [{
    id: "demo-controls", title: "Control character note", type: "Task", status: "closed",
    change_facets: [{ audience: "operator", text }],
  }] });
  const encoded = formatAudienceContracts(report, "toon");
  assert.deepEqual(decode(encoded), report);
  assert.equal(report.contracts[0].notes[0].text, text);
  for (const escape of ["\\u000c", "\\u0008", "\\u0000", "\\u001f"]) assert.ok(encoded.includes(escape), escape);
  assert.deepEqual(JSON.parse(formatAudienceContracts(report, "json")), report);
});

test("mixed releases are byte stable in JSON and lossless TOON with a common ledger", () => {
  const options = { items: mixed, groupBy: "release" as const };
  const report = buildAudienceContracts(options);
  assert.equal(report.item_count, 3);
  assert.equal(report.note_count, 4);
  assert.equal(report.omission_count, 5);
  assert.deepEqual(buildAudienceContracts({ ...options, items: [...mixed].reverse() }), report);
  for (const format of ["json", "toon"] as const) {
    const actual = formatAudienceContracts(report, format);
    assert.equal(actual, readFileSync(join(fixtures, `mixed.${format}`), "utf8"));
    assert.deepEqual(format === "json" ? JSON.parse(actual) : decode(actual), report);
  }
  const original = JSON.stringify(mixed);
  for (const audience of CHANGE_AUDIENCES) {
    const view = buildAudienceContracts({ ...options, audience });
    assert.deepEqual(view.ledger, report.ledger);
    assert.equal(view.ledger_sha256, report.ledger_sha256);
    assert.deepEqual(view.contracts, report.contracts.filter((contract) => contract.audience === audience));
    assert.doesNotMatch(JSON.stringify(view), /Internal cache defect|Private implementation title|Never infer this title|Not delivered|Non-change closure/);
  }
  assert.doesNotMatch(JSON.stringify(buildAudienceContracts({ ...options, audience: "api-user" })), /Fixed cache refresh|Refresh cached context/);
  assert.equal(JSON.stringify(mixed), original);
});

test("explicit facets deduplicate and sort; missing resolutions never become titles", () => {
  const item: PmItem = { id: "demo-a", title: "Never infer this", status: "closed", type: "Issue", close_reason: "Closed on GitHub as completed", change_facets: [
    { audience: "operator", source: "close_reason" }, { audience: "operator", text: "Z" },
    { audience: "operator", text: "A" }, { audience: "operator", text: "A" },
  ] };
  const report = buildAudienceContracts({ items: [item], audience: "operator" });
  assert.deepEqual(report.contracts[0].notes.map((row) => row.text), ["A", "Closed on GitHub as completed", "Z"]);
  assert.equal(report.ledger[0].section, "Closed");
  for (const reason of [undefined, "", "  ", 42]) {
    const missing = buildAudienceContracts({ items: [{ ...item, close_reason: reason } as PmItem], audience: "operator" });
    assert.deepEqual(missing.contracts[0].omissions, [{ attribution: 0, reason: "missing_resolution" }]);
    assert.doesNotMatch(JSON.stringify(missing), /Never infer this/);
  }
  const empty = buildAudienceContracts({ items: [] });
  assert.equal(empty.note_count, 0);
  assert.deepEqual(decode(formatAudienceContracts(empty, "toon")), empty);
  const absent = buildAudienceContracts({ items: [{ ...item, change_facets: [] }] });
  assert.equal(absent.omission_count, 3);
});

test("malformed declarations and ambiguous identity refuse with typed remedies", () => {
  const item: PmItem = { id: "demo-a", title: "A", status: "closed" };
  for (const id of [undefined, "", " ", 7]) {
    assert.throws(() => buildAudienceContracts({ items: [{ ...item, id } as PmItem] }), refusal("ambiguous_items"));
  }
  assert.throws(() => buildAudienceContracts({ items: [item, item] }), refusal("ambiguous_items"));
  assert.throws(() => parseChangeAudience("typo"), refusal("invalid_audience"));
  assert.equal(parseChangeAudience("api-user"), "api-user");
  assert.equal(JSON.parse(cliTestSurface.errorMessage(new AudienceContractError("invalid_facets", "Repair the declarations."))).error.remedy, "Repair the declarations.");
  for (const value of [null, {}, "prose", [null], [1], [[]], [{ audience: "operator", text: "" }], [{ audience: "operator", text: " " }],
    [{ audience: "operator", text: 4 }], [{ audience: "operator", text: "X", source: "close_reason" }],
    [{ audience: "operator", source: "title" }], [{ audience: "operator", text: "X", extra: true }]]) {
    assert.throws(() => buildAudienceContracts({ items: [{ ...item, change_facets: value } as PmItem] }), refusal("invalid_facets"));
  }
  assert.throws(() => buildAudienceContracts({ items: [{ ...item, change_facets: [{ audience: "typo", text: "X" }] } as unknown as PmItem] }), refusal("invalid_audience"));
});

test("contract selection reuses release windows, section rules and exclusions", () => {
  const report = buildAudienceContracts({ items: mixed, groupBy: "release", sectionBy: "type" });
  assert.equal(report.item_count, 3);
  assert.deepEqual(report.ledger.map((row) => row.section), ["Issue", "Task", "Feature"]);
  const releaseWindows = [{ heading: "2.0.0 - 2026-10-20", releaseTag: "v2.0.0", since: "2026-10-20" }, { heading: "1.0.0 - 2026-10-19", releaseTag: "v1.0.0", until: "2026-10-19T23:59:59Z" }];
  const one = buildAudienceContracts({ items: mixed, releaseWindows, limit: 1 });
  assert.equal(one.item_count, 2);
  assert.equal(buildAudienceContracts({ items: mixed, releaseWindows, sinceVersion: "2.0.0" }).item_count, 2);
  const sameSection = ["z", "a", "m"].map((id) => ({ id, title: id, status: "closed", type: "Task" }));
  assert.deepEqual(buildAudienceContracts({ items: sameSection }).ledger.map((row) => row.item), ["a", "m", "z"]);
  assert.deepEqual(buildAudienceContracts({ items: sameSection.map((item) => ({ ...item, title: item.id === "a" ? "Z" : item.id === "z" ? "A" : "M" })) }).ledger.map((row) => row.item), ["a", "m", "z"]);
  assert.equal(buildAudienceContracts({ items: mixed, since: "2026-10-20", until: "2026-10-20T23:59:59Z" }).item_count, 2);
  const excluded = mixed.map((item) => ({ ...item, tags: ["internal"] }));
  assert.equal(buildAudienceContracts({ items: excluded, excludeTags: ["internal"] }).item_count, 0);
});

test("SDK, standalone and actual pm host publish core facets without git", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-audience-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const pmRoot = join(cwd, ".agents/pm");
  const env: NodeJS.ProcessEnv = { ...process.env, PM_AUTHOR: "fixture", PM_GLOBAL_PATH: join(cwd, "global"), PM_PATH: pmRoot, DO_NOT_TRACK: "1", GIT_CEILING_DIRECTORIES: dirname(cwd) };
  await runInit("pm", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  const extensionRoot = join(pmRoot, "extensions/pm-changelog");
  mkdirSync(extensionRoot, { recursive: true });
  cpSync(resolve("dist"), join(extensionRoot, "dist"), { recursive: true });
  cpSync(resolve("manifest.json"), join(extensionRoot, "manifest.json"));
  writeFileSync(join(extensionRoot, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(resolve("node_modules"), join(extensionRoot, "node_modules"), "junction");
  await runWithActiveExtensions({ path: pmRoot }, async () => {
    await runCreate({ title: "Do not publish this title", type: "Task", status: "closed", closeReason: "Delivered contract fixture", completedAt: "2026-10-20T00:00:00Z", createMode: "progressive",
      field: [`change_facets=${JSON.stringify([{ audience: "operator", text: "Restart the fixture worker." }])}`] }, { path: pmRoot });
  });
  const noGit = join(cwd, "bin");
  mkdirSync(noGit);
  env.PATH = noGit;
  const savedPath = process.env.PATH;
  process.env.PATH = noGit;
  t.after(() => { process.env.PATH = savedPath; });
  const expected = await readAudienceContracts(pmRoot);
  assert.equal(expected.note_count, 1);
  assert.equal(expected.omission_count, 2);
  assert.deepEqual(await readAudienceContracts(pmRoot, { audience: "operator" }), buildAudienceContracts({ items: (await importFixtureItems(pmRoot)), audience: "operator" }));
  const cli = resolve("dist/cli.js");
  for (const args of [["contracts", "--pm-root", pmRoot], ["contracts", "--pm-root", pmRoot, "--json"], ["contracts", "--pm-root", pmRoot, "--format", "json"]]) {
    const run = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(args.includes("--json") || args.includes("--format") ? JSON.parse(run.stdout) : decode(run.stdout), expected);
  }
  const pm = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const mutation = spawnSync(process.execPath, [pm, "--path", pmRoot, "update", expected.ledger[0].item,
    "--field", `change_facets=${JSON.stringify([{ audience: "operator", text: "Restart the fixture worker." }])}`], { cwd, env, encoding: "utf8" });
  assert.equal(mutation.status, 0, mutation.stderr);
  for (const flags of [["--format", "json"], ["--format", "toon"]]) {
    const run = spawnSync(process.execPath, [pm, "--path", pmRoot, "changelog", "contracts", ...flags], { cwd, env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(flags[1] === "json" ? JSON.parse(run.stdout) : decode(run.stdout), expected);
  }
  const bad = spawnSync(process.execPath, [cli, "contracts", "--pm-root", pmRoot, "--audience", "typo"], { cwd, env, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).error.code, "invalid_audience");
  assert.ok(JSON.parse(bad.stderr).error.remedy);
  const hostBad = spawnSync(process.execPath, [pm, "--path", pmRoot, "changelog", "contracts", "--audience", "typo"], { cwd, env, encoding: "utf8" });
  assert.notEqual(hostBad.status, 0);
  assert.match(hostBad.stderr, /invalid_audience/);
  const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] });
  assert.deepEqual(activation.failed, []);
  for (const json of [false, true]) {
    const result = await runRegisteredCommandForTest(activation.commands, { command: "changelog contracts", pmRoot, global: { json } });
    const output = (result.result as { output: string }).output;
    assert.deepEqual(json ? JSON.parse(output) : decode(output), expected);
  }
  const writes: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
  await cliTestSurface.main(["contracts", "--pm-root", pmRoot, "--format", "json"]);
  assert.deepEqual(JSON.parse(writes.pop()!), expected);
  await runAudienceContractsCli(["--pm-root", pmRoot, "--json"]);
  assert.deepEqual(JSON.parse(writes.pop()!), expected);
  await runAudienceContractsCli(["--help"]);
  assert.match(writes.pop()!, /missing facets produce omissions/);
  assert.deepEqual(JSON.parse(await runAudienceContractsCommand(pmRoot, { audience: "operator", groupBy: "milestone", sectionBy: "status", releaseVersion: "2" }, true)).contracts[0].audience, "operator");
  assert.equal(JSON.parse(await runAudienceContractsCommand(pmRoot, { "group-by": "release", "section-by": "label", "release-version": "2", format: "json" })).note_count, 1);
  for (const options of [{ format: "md" }, { "group-by": "oops" }, { "section-by": "oops" }, { "release-version": 4 }]) {
    await assert.rejects(() => runAudienceContractsCommand(pmRoot, options), refusal("invalid_contract_options"));
  }
  for (const args of [["--unknown"], ["--audience"], ["positional"]]) {
    await assert.rejects(() => runAudienceContractsCli(args), refusal("invalid_contract_options"));
  }
});

/** Read test rows through the same certified core SDK used by a backend client. */
async function importFixtureItems(pmRoot: string): Promise<PmItem[]> {
  return (await listAllComplete({ includeBody: false }, { pmRoot })).items;
}
