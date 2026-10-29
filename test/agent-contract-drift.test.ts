import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { SETTINGS_DEFAULTS, canonicalDocument, listAllComplete, readSettings, resolveRuntimeStatusRegistry, runCreate, runFocus, runInit, runUpdate, runWithActiveExtensions, schemaAddStatus } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, decodeToon, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import { AgentContractDriftError, buildAgentContractDrift, buildAudienceContracts, createChangelog, formatAgentContractDrift, parseAgentContractRange, parseAgentObligation, readAgentContractDrift } from "../src/index.ts";
import type { AgentContractDriftReport, AgentObligation, ChangeFacet, PmItem } from "../src/index.ts";
import { runAgentContractDriftCli, runAgentContractDriftCommand } from "../src/agent-contract-command.ts";
import { cliTestSurface } from "../src/cli.ts";
import extension from "../src/extension.ts";

const range = { from: "1.0.0", to: "10.0.0" };
/** Author a closed, versioned agent facet while keeping ordinary prose out of the index. */
function change(id: string, release: string, obligations: unknown): PmItem {
  return { id, title: "Do not infer this title", status: "closed", type: "Feature", release,
    close_reason: "Declared agent behavior for this release.",
    change_facets: [{ audience: "agent-behavior", text: "Declared agent behavior for this release.", obligations }] as ChangeFacet[] };
}
/** Strict producer canonicalizes only sets; authored assumptions remain byte exact. */
function obligation(id = "context", assumption = "Read current context before mutation"): AgentObligation {
  return parseAgentObligation({ id, assumption, commands: ["pm update", "pm create", "pm create"], evidence: ["evidence-context"] });
}
/** Ten releases exercise repeats, removals, reintroduction and changes that later revert. */
function tenReleases(): PmItem[] {
  return Array.from({ length: 10 }, (_, index) => {
    const declarations: AgentObligation[] = [
      obligation("context", index >= 4 && index < 6 ? "Read history and context before mutation" : undefined),
      ...(index < 2 ? [obligation("claim", "Claim before writing")] : index === 2 ? [{ id: "claim", removed: true as const, evidence: ["evidence-retire"] }] : []),
      ...(index === 7 ? [obligation("claim", "Claim before writing")] : []),
      ...(index >= 1 ? [obligation("retry", "Re-read the target revision before retry")] : []),
    ];
    const item = change(`fixture-${index + 1}`, `${index + 1}.0.0`, declarations);
    item.close_reason = `Published agent behavior contract for release ${index + 1}.0.0. ` + declarations.map((row) => row.removed
      ? `Retired obligation ${row.id}. Evidence: ${row.evidence.join(", ")}.`
      : `Obligation ${row.id}: ${row.assumption}. Affected commands: ${row.commands.join(", ")}. Evidence: ${row.evidence.join(", ")}.`).join(" ");
    item.change_facets![0].text = item.close_reason;
    return item;
  });
}

/** Machine refusal assertions check actual expected-error identity and remedy. */
function refusal(code: AgentContractDriftError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof AgentContractDriftError && error.code === code && error.exitCode !== 0 && !!error.remedy;
}

test("ten releases retain every transition, evidence and unchanged references in fewer bytes than notes", (t) => {
  const items = tenReleases(), original = structuredClone(items);
  const report = buildAgentContractDrift({ ...range, items });
  assert.deepEqual(report.changes.map(({ release, id, kind }) => [release, id, kind]), [
    ["2.0.0", "retry", "added"], ["3.0.0", "claim", "removed"], ["5.0.0", "context", "changed"],
    ["7.0.0", "context", "changed"], ["8.0.0", "claim", "added"],
  ]);
  assert.equal(report.baseline.length, 2);
  assert.equal(report.definitions.length, 4);
  assert.equal(report.unchanged.length, 16);
  assert.equal(report.complete, true);
  assert.deepEqual(report.changes[1].evidence, ["evidence-retire"]);
  assert.deepEqual(report.definitions[report.changes[1].before!].commands, ["pm create", "pm update"]);
  assert.equal(report.changes[2].after, report.changes[3].before);
  assert.equal(report.changes[2].before, report.changes[3].after);
  assert.deepEqual(buildAgentContractDrift({ ...range, items: [...items].reverse() }), report);
  const notes = items.map((item) => createChangelog({ items: [item], version: item.release, entryFrom: "close_reason" }).markdown).join("");
  for (const format of ["json", "toon"] as const) {
    const serialized = formatAgentContractDrift(report, format);
    assert.deepEqual(format === "json" ? JSON.parse(serialized) : decodeToon(serialized), report);
    assert.ok(Buffer.byteLength(serialized) < Buffer.byteLength(notes));
    t.diagnostic(`${format}_bytes=${Buffer.byteLength(serialized)} concatenated_notes_bytes=${Buffer.byteLength(notes)}`);
  }
  assert.doesNotMatch(JSON.stringify(report), /Ordinary release prose|Do not infer/);
  assert.deepEqual(items, original);
  assert.equal(buildAudienceContracts({ items, audience: "agent-behavior" }).note_count, 10);
  assert.equal(buildAgentContractDrift({ ...range, from: "9.0.0", items }).changes.length, 0);
  assert.equal(buildAgentContractDrift({ ...range, from: "0.0.0", items }).changes.length, 7);
  assert.deepEqual(buildAgentContractDrift({ ...range, items: [] }).definitions, []);
});

test("command-set changes are obligations; unsupported generator filters cannot publish active work", () => {
  const first = obligation(), second = { ...first, commands: ["pm recover"] };
  const items = [change("command-before", "1.0.0", [first]), change("command-after", "2.0.0", [second])];
  const report = buildAgentContractDrift({ ...range, items });
  assert.equal(report.changes[0].kind, "changed");
  assert.deepEqual(report.definitions[report.changes[0].before!].commands, ["pm create", "pm update"]);
  assert.deepEqual(report.definitions[report.changes[0].after!].commands, ["pm recover"]);
  const active = { ...items[1], status: "open" };
  assert.deepEqual(buildAgentContractDrift({ ...range, items: [active], includeStatuses: ["open"] } as never).changes, []);
});

test("legacy facets, invalid records and orphan removals are isolated omissions; foreign audiences are skipped", () => {
  const good = obligation();
  const item = change("fixture-bad", "2.0.0", [null, good, { id: "orphan", removed: true, evidence: ["e"] }]);
  const items = [item, change("fixture-legacy", "3.0.0", undefined), change("fixture-string", "Unreleased", [good]),
    change("fixture-hole", "4.0.0", new Array(1)), change("fixture-later", "11.0.0", null),
    { ...change("fixture-facets", "2.0.0", []), change_facets: null },
    { ...change("fixture-primitive", "2.0.0", []), change_facets: [null, { audience: "operator", obligations: [good] }] },
    { ...change("fixture-absent", "2.0.0", []), change_facets: undefined }] as PmItem[];
  const report = buildAgentContractDrift({ ...range, items });
  assert.equal(report.complete, false);
  assert.equal(report.changes.length, 1);
  assert.equal(report.changes[0].id, good.id);
  assert.deepEqual(report.omissions.map((row) => row.reason).sort(), ["invalid_facets", "invalid_facets", "invalid_obligation", "invalid_obligation", "missing_obligations", "orphan_removal", "unversioned"].sort());
  assert.deepEqual(decodeToon(formatAgentContractDrift(report, "toon")), report);
  assert.deepEqual(buildAgentContractDrift({ ...range, items: [...items].reverse() }), report);
  const removedBaseline = [change("fixture-base", "0.1.0", [good]), change("fixture-remove", "1.0.0", [{ id: good.id, removed: true, evidence: ["retired"] }])];
  assert.deepEqual(buildAgentContractDrift({ ...range, items: removedBaseline }).baseline, []);
  const duplicate = change("fixture-duplicate", "2.0.0", [{ ...good, evidence: ["second"] }]);
  const merged = buildAgentContractDrift({ ...range, items: [change("fixture-a", "v2.0.0", [good, good]), duplicate] });
  assert.deepEqual(merged.changes[0].evidence, ["evidence-context", "second"]);
  assert.deepEqual(merged.changes[0].items, ["fixture-a", "fixture-duplicate"]);
  for (const conflict of [{ ...good, assumption: "Conflicting" }, { id: good.id, removed: true, evidence: ["e"] }]) {
    assert.throws(() => buildAgentContractDrift({ ...range, items: [duplicate, change("fixture-conflict", "2.0.0", [conflict])] }), refusal("ambiguous_contract"));
  }
});

test("strict boundary must-refuse and legacy must-allow corpus includes sparse arrays and extreme numbers", () => {
  const good = obligation();
  assert.deepEqual(parseAgentObligation(good), good);
  for (const assumption of ["  leading trailing  ", "line\r\n\tline", 'quotes " \\ \u0000\f\b']) {
    const input = { ...good, assumption };
    assert.deepEqual(parseAgentObligation(input), input);
  }
  for (const bad of [undefined, null, 1, [], {}, { ...good, extra: true }, { ...good, id: " a" }, { ...good, id: "" }, { ...good, id: "a".repeat(161) },
    { ...good, assumption: " " }, { ...good, assumption: "x".repeat(8193) }, { ...good, assumption: Infinity },
    { ...good, commands: new Array(1) }, { ...good, commands: Array(65).fill("pm create") }, { ...good, commands: [] }, { ...good, commands: [NaN] },
    { ...good, evidence: [] }, { ...good, evidence: ["x".repeat(257)] }, { ...good, removed: false }, { ...good, removed: true }]) {
    assert.throws(() => parseAgentObligation(bad), refusal("invalid_obligation"));
  }
  assert.deepEqual(parseAgentObligation({ id: "constructor", removed: true, evidence: ["e"] }), { id: "constructor", removed: true, evidence: ["e"] });
  for (const bad of [undefined, null, NaN, Infinity, "", " 1.0.0", "1.0.0-rc", "1.0.0+build", "01.0.0", "9".repeat(81), "9007199254740992.0.0", "10.0.0", "11.0.0"]) {
    assert.throws(() => parseAgentContractRange(bad, range.to), refusal("invalid_drift_options"));
  }
  assert.throws(() => parseAgentContractRange("1.0.0", null), refusal("invalid_drift_options"));
  assert.deepEqual(parseAgentContractRange("v2026.10.28", "2026.10.28-1"), { from: "2026.10.28", to: "2026.10.28-1" });
  for (const items of [new Array(1), Array(100001), [null], [[]], [{ title: "X" }], [{ id: " ", title: "X" }], [{ id: "a", title: 1 }], [change("a", "2.0.0", []), change("a", "3.0.0", [])]]) {
    assert.throws(() => buildAgentContractDrift({ ...range, items } as never), AgentContractDriftError);
  }
  const legacy = JSON.parse(readFileSync(resolve("test/fixtures/audience-contracts/items.json"), "utf8")) as PmItem[];
  assert.doesNotThrow(() => formatAgentContractDrift(buildAgentContractDrift({ ...range, items: legacy }), "json"));
});

test("aggregate schema budgets refuse before unbounded output even with repeated declarations", () => {
  const good = obligation();
  const items = Array.from({ length: 400 }, (_, index) => change(`budget-${index}`, "2.0.0", Array(256).fill(good)));
  assert.throws(() => buildAgentContractDrift({ ...range, items }), refusal("invalid_drift_options"));
  const facets = Array(256).fill({ audience: "agent-behavior" });
  const omitted = Array.from({ length: 400 }, (_, index) => ({ ...change(`omitted-${index}`, "2.0.0", []), change_facets: facets }));
  assert.throws(() => buildAgentContractDrift({ ...range, items: omitted }), refusal("invalid_drift_options"));
});

test("every emitted number is checked; malformed reports refuse before serialization", () => {
  const report = buildAgentContractDrift({ ...range, items: tenReleases() });
  const variants: unknown[] = [null, { ...report, extra: Infinity }, { ...report, schema_version: NaN }, { ...report, complete: "yes" },
    { ...report, complete: false }, { ...report, definitions: [null] }, { ...report, baseline: [null] }, { ...report, changes: [null] }, { ...report, omissions: [null] }];
  for (const invalid of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER, null]) {
    variants.push({ ...report, baseline: [{ ...report.baseline[0], ref: invalid }] });
    variants.push({ ...report, changes: [{ ...report.changes[0], after: invalid }] });
    if (invalid !== null) variants.push({ ...report, complete: false, omissions: [{ item: "fixture", facet: invalid, obligation: 0, reason: "invalid_obligation" }] });
  }
  variants.push({ ...report, changes: [{ ...report.changes[0], id: "wrong" }] });
  variants.push({ ...report, baseline: [{ ...report.baseline[0], release: "Unreleased" }] });
  variants.push({ ...report, changes: [{ ...report.changes[0], release: "Unreleased" }] });
  variants.push({ ...report, complete: false, omissions: [{ item: "fixture", facet: 0, obligation: 256, reason: "wrong" }] });
  variants.push({ ...report, complete: false, omissions: [{ item: "fixture", facet: null, obligation: null, reason: "wrong" }] });
  for (const variant of variants) assert.throws(() => formatAgentContractDrift(variant as AgentContractDriftReport, "json"), refusal("invalid_drift_report"));
  assert.throws(() => formatAgentContractDrift(report, "xml" as "json"), refusal("invalid_drift_report"));
});

/** Install the actual extension into an initialized plain directory, with explicit native scope. */
async function tracker(cwd: string): Promise<string> {
  const root = join(cwd, ".agents/pm");
  await runInit("fixture", { path: root }, { defaults: true, agentGuidance: "skip" });
  const target = join(root, "extensions/pm-changelog");
  mkdirSync(target, { recursive: true }); cpSync(resolve("dist"), join(target, "dist"), { recursive: true });
  cpSync(resolve("manifest.json"), join(target, "manifest.json"));
  writeFileSync(join(target, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(resolve("node_modules"), join(target, "node_modules"), "junction");
  return root;
}

test("real host, standalone and SDK agree without git and reject unusable guards before reads", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-drift-cli-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = await tracker(cwd);
  await runWithActiveExtensions({ path: root }, async () => {
    for (const item of tenReleases()) await runCreate({ id: item.id, title: item.title, type: "Feature", status: "closed", closeReason: "Delivered fixture", release: item.release,
      completedAt: "2026-10-28T00:00:00.000Z", createMode: "progressive", field: [`change_facets=${JSON.stringify(item.change_facets)}`],
      unset: ["parent", "goal", "objective", "sprint", "assignee", "reviewer"] }, { path: root, author: "fixture" });
  });
  const expected = await readAgentContractDrift(root, range), before = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
  const bin = join(cwd, "bin"); mkdirSync(bin);
  const env = { PATH: bin, PM_AUTHOR: "fixture", PM_GLOBAL_PATH: join(cwd, "global"), PM_PATH: root, DO_NOT_TRACK: "1", GIT_CEILING_DIRECTORIES: dirname(cwd) };
  const args = ["--from", range.from, "--to", range.to];
  for (const flags of [[], ["--json"], ["--format", "json"], ["--format", "toon"]]) for (const command of [
    [resolve("dist/cli.js"), "drift", "--pm-root", root], [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", root, "changelog", "drift"],
  ]) {
    const result = spawnSync(process.execPath, [...command, ...args, ...flags], { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(flags.includes("json") || flags.includes("--json") ? JSON.parse(result.stdout) : decodeToon(result.stdout), expected);
  }
  const invalid = spawnSync(process.execPath, [resolve("dist/cli.js"), "drift", "--pm-root", root, ...args, "--format", "xml"], { cwd, env, encoding: "utf8" });
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /invalid_drift_options/);
  const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] });
  for (const json of [true, false]) {
    const result = await runRegisteredCommandForTest(activation.commands, { command: "changelog drift", pmRoot: root, options: range, global: { json } });
    const output = (result.result as { output: string }).output;
    assert.deepEqual(json ? JSON.parse(output) : decodeToon(output), expected);
  }
  const writes: string[] = []; t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
  await runAgentContractDriftCli(["--help"]); assert.match(writes.pop()!, /no prose inference/);
  await runAgentContractDriftCli(["--pm-root", root, ...args]); assert.deepEqual(decodeToon(writes.pop()!), expected);
  await runAgentContractDriftCli(["--pm-root", root, ...args, "--json"]); assert.deepEqual(JSON.parse(writes.pop()!), expected);
  for (const args of [["--unknown"], ["--from"], ["--from", "1.0.0", "--to", "Unreleased"]]) await assert.rejects(() => runAgentContractDriftCli(args), refusal("invalid_drift_options"));
  await assert.rejects(() => runAgentContractDriftCommand("missing", { ...range, format: "xml" }), refusal("invalid_drift_options"));
  await assert.rejects(() => readAgentContractDrift("missing", { from: "bad", to: "bad" }), refusal("invalid_drift_options"));
  assert.equal(JSON.parse(cliTestSurface.errorMessage(new AgentContractDriftError("invalid_obligation", "Repair declarations."))).error.remedy, "Repair declarations.");
  assert.deepEqual((await listAllComplete({ includeBody: true }, { pmRoot: root })).items, before);
});

/** Repeatable independent operation generator; no dependency on implementation normalization. */
function random(seed: number): () => number {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 8; };
}

test("500 random custom status registries publish only SDK done roles irrespective of names or aliases", () => {
  const next = random(0x9a71c);
  const roles = [["active"], ["blocked"], ["terminal", "terminal_canceled"], ["terminal", "terminal_done"]] as const;
  for (let sequence = 0; sequence < 500; sequence++) {
    const statuses = Array.from({ length: 4 }, (_, index) => {
      const kind = next() % roles.length;
      return { id: `state_${next().toString(36)}_${index}`, aliases: [`alias_${next().toString(36)}`], roles: [...roles[kind]], kind };
    });
    const registry = resolveRuntimeStatusRegistry({ ...SETTINGS_DEFAULTS.schema,
      statuses: [...SETTINGS_DEFAULTS.schema.statuses!, ...statuses.map(({ id, aliases, roles }) => ({ id, aliases, roles }))] });
    const items = statuses.map((status, index) => ({ ...change(`random-${index}`, "2.0.0", [obligation(`contract-${index}`)]),
      status: next() % 2 ? status.id : `  ${status.aliases[0].toUpperCase()}\r\n` }));
    const report = buildAgentContractDrift({ ...range, items, statusRegistry: registry });
    assert.deepEqual(report.changes.map((row) => row.id), statuses.flatMap((status, index) => status.kind === 3 ? [`contract-${index}`] : []));
    for (const format of ["json", "toon"] as const) assert.deepEqual(format === "json" ? JSON.parse(formatAgentContractDrift(report, format)) : decodeToon(formatAgentContractDrift(report, format)), report);
  }
});

test("500 seeded SDK-read model sequences cover old replays, whitespace, relationships and custom role registries", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-drift-model-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = await tracker(cwd), next = random(0x6dc1f7);
  const roles = [["active"], ["blocked"], ["terminal", "terminal_canceled"], ["terminal", "terminal_done"]];
  for (let index = 0; index < 4; index++) await schemaAddStatus(`custom_${index}`, { role: roles[index], alias: [`alias_${index}`] }, { pmRoot: root });
  const registry = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
  const archive: { body: string; facets: ChangeFacet[]; release: string; priority: number; tags: string[]; dep: string; status: string }[] = [];
  const variants = ["plain", "  whitespace  ", "line\r\nnext\t ", 'control\u0000\b\f " \\'];
  await runWithActiveExtensions({ path: root }, async () => {
    for (const [id, release] of [["fixture-parent", "0.1.0"], ["fixture-target", "2.0.0"], ["fixture-related", "0.1.0"]]) await runCreate({ id, title: id, type: "Feature", status: "open", release,
      createMode: "progressive", body: "native", description: "native description", resolution: "native resolution", actualResult: "native result", tags: "native",
      file: ["path=fixture.ts"], doc: ["path=fixture.md"], test: ["command=node --version"], comment: ["text=fixture comment"], note: ["text=fixture note"], learning: ["text=fixture learning"],
      unset: ["parent", "goal", "objective", "sprint", "assignee", "reviewer"] }, { path: root, author: "fixture" });
    const baseline = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items.find((item) => item.id === "fixture-target")!;
    for (let sequence = 0; sequence < 500; sequence++) {
      const variant = variants[next() % variants.length];
      const state = { body: variant, release: `${2 + next() % 9}.0.0`, priority: next() % 5, tags: ["native", `variant-${next() % 4}`], dep: next() % 2 ? "fixture-parent" : "fixture-related",
        status: `custom_${next() % 4}`, facets: [{ audience: "agent-behavior" as const, text: variant,
          obligations: [obligation("constructor", variant), ...(next() % 2 ? [obligation("retry", variant)] : [])] }] };
      archive.push(structuredClone(state));
      await runFocus(next() % 2 ? "fixture-parent" : "fixture-related", {}, { path: root, author: "fixture" });
      for (const input of [state, archive[next() % archive.length], state]) {
        await runUpdate("fixture-target", { body: input.body, release: input.release, priority: input.priority, tags: input.tags.join(","), status: input.status, resolution: "native resolution", actualResult: "native result",
          field: [`change_facets=${JSON.stringify(input.facets)}`], dep: [`id=${input.dep},kind=related`], replaceDeps: true,
          unset: ["parent", "goal", "objective", "sprint", "assignee", "reviewer"] }, { path: root, author: "fixture" });
        const readback = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
        const actual = readback.find((item) => item.id === "fixture-target")!;
        for (const key of ["id", "title", "type", "description", "resolution", "actual_result", "files", "docs", "tests", "comments", "notes", "learnings", "created_at"]) assert.deepEqual(actual[key], baseline[key], key);
        assert.equal(actual.body, canonicalDocument({ metadata: actual, body: input.body }).body);
        assert.equal(actual.release, input.release); assert.equal(actual.priority, input.priority); assert.deepEqual(actual.tags, input.tags);
        assert.deepEqual(actual.change_facets, input.facets); assert.equal(actual.status, input.status);
        assert.ok(actual.dependencies?.some((dep) => dep.id === input.dep && dep.kind === "related"));
        for (const key of ["parent", "goal", "objective", "sprint", "assignee", "reviewer"]) assert.ok(actual[key] === null || actual[key] === undefined);
        const report = await readAgentContractDrift(root, range);
        const included = registry.terminal_done_statuses.has(input.status);
        const expected = included ? input.facets[0].obligations!.map((row) => row.id).sort() : [];
        assert.deepEqual(report.changes.map((row) => row.id), expected);
        for (const format of ["json", "toon"] as const) assert.deepEqual(format === "json" ? JSON.parse(formatAgentContractDrift(report, format)) : decodeToon(formatAgentContractDrift(report, format)), report);
        const aliasItems = readback.map((item) => item.id === actual.id ? { ...item, status: `  ALIAS_${input.status.slice(-1)}\r\n` } : item);
        assert.deepEqual(buildAgentContractDrift({ ...range, items: aliasItems, statusRegistry: registry }), report);
        assert.deepEqual((await listAllComplete({ includeBody: true }, { pmRoot: root })).items, readback);
      }
    }
  });
  t.diagnostic("seed=0x6dc1f7 sequences=500; each applies current, older replay and current input; SDK-read native state, relationships, roles and both encodings");
});
