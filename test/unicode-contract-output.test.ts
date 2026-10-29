import { formatLocalTimestampDate } from "../src/release-context.ts";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { PmCliError, runInit, runCreate, runWithActiveExtensions, listAllComplete } from "@unbrained/pm-cli/sdk";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";
import { extensionTestSurface } from "../src/extension.ts";
import { cliTestSurface } from "../src/cli.ts";
import { createHash } from "node:crypto";
import { buildAgentContractDrift, parseAgentObligation, formatAgentContractDrift, buildAudienceContracts, formatAudienceContracts,
  buildConsumerUpgrades, formatConsumerUpgrades, buildChangelogDocument, createChangelog, createChangelogSummary, explainChangelogSelection, formatClaimAudit, auditChangelogClaims, parseReleaseCorrection, formatReleaseCorrection, formatReleaseCorrectionView } from "../src/index.ts";
import type { PmItem, AgentContractDriftReport, AudienceContractReport, ConsumerUpgradeReport, ClaimAuditReport, ReleaseCorrection, ReleaseCorrectionView } from "../src/index.ts";
import { encodeUnicodeOutput, normalizeUnicodeOutput, normalizeUnicodeText, stringifyUnicodeOutput, UnicodeOutputError } from "../src/output-unicode.ts";

/** Independent UTF-8 boundary oracle; no package normalizer participates in expected values. */
function expected(value: unknown): unknown {
  if (typeof value === "string") return Buffer.from(value, "utf8").toString("utf8");
  if (Array.isArray(value)) return value.map(expected);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [expected(key) as string, expected(entry)]));
  return value;
}
/** Enumerate every text leaf, including arrays, of a JSON-shaped report. */
function fields(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (typeof value === "string") return [path];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => fields(entry, [...path, Array.isArray(value) ? Number(key) : key]));
}
/** Change exactly one text field in a detached test record. */
function changed<T>(value: T, path: (string | number)[], text: string): T {
  const copy: unknown = structuredClone(value);
  let current = copy as Record<string | number, unknown>;
  for (const part of path.slice(0, -1)) current = current[part] as Record<string | number, unknown>;
  current[path.at(-1)!] = text;
  return copy as T;
}
/** Generate arbitrary code units, forcing high/low lone surrogates and preserving valid pairs. */
function strings(): string[] {
  let state = 0x298f16;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const edge = ["\ud800", "\udfff", "\ud800X\udc00", "\ud83d\ude00", "\u0000\f\b\r\n\t", "é漢字", '"\\', "plain"];
  return Array.from({ length: 500 }, (_, index) => `text ${edge[index % edge.length]} ${Array.from({ length: next() % 16 }, () => String.fromCharCode(next() & 0xffff)).join("")}`);
}
/** Decode the audit format's documented JSON scalar cells through the real TOON codec. */
function decodeAudit(output: string): unknown {
  const value = decodeToon(output) as { claims: { items: string; gaps: string }[]; evidence: string[]; remedies: string };
  return { ...value, claims: value.claims.map((row) => ({ ...row, items: JSON.parse(row.items), gaps: JSON.parse(row.gaps) })),
    evidence: value.evidence.map((row) => JSON.parse(row)), remedies: JSON.parse(value.remedies) };
}
const range = { from: "1.0.0", to: "2.0.0" };
/** Author explicit metadata only, independent of ordinary tracker prose. */
function item(text = "Read revision"): PmItem {
  return { id: "source", title: "Source", body: "A😀 body", description: "Description", tags: ["tag"], milestone: "milestone", url: "https://example.invalid/source", assignee: "fixture", author: "fixture",
    files: [{ path: "src/source.ts", label: "Source" }], tests: [{ command: "node --test" }], actual_result: "Delivered change", resolution: "Fixed condition", type: "Feature", status: "closed", release: "2.0.0", close_reason: "Delivered", change_facets: [
    { audience: "agent-behavior", text, breaking: true, obligations: [{ id: "obligation", assumption: text, commands: ["pm apply"], evidence: ["evidence"] }], upgrade_actions: [{ id: "upgrade", title: text, body: text, requires: [] }] },
  ] };
}

test("Unicode boundary: 500 random strings in every declaration and report text field agree in JSON and TOON", (t) => {
  const drift = buildAgentContractDrift({ ...range, items: [item()] });
  const audience = buildAudienceContracts({ items: [item()], groupBy: "release" });
  const upgrades = buildConsumerUpgrades({ ...range, audience: "agent-behavior", items: [item()] });
  const audit = auditChangelogClaims({ items: [item()], groupBy: "release" });
  const correction = parseReleaseCorrection({ schema: 1, release: "v1", item: "source", id: "correction", supersedes: "", milestone: "a".repeat(64), expectedRevision: "b".repeat(64), wording: "Exact prose", evidence: ["proof"] });
  const view: ReleaseCorrectionView = { schema: 1, release: "v1", item: "source", milestone: "a".repeat(64), original: "Original", current: "Exact prose", revision: "b".repeat(64), chain: [correction], skipped: { foreign: 0, invalid: 0, unrelated: 0 } };
  const generated = JSON.parse(JSON.stringify({ document: buildChangelogDocument({ items: [item()], groupBy: "release" }),
    summary: createChangelogSummary({ items: [item()], groupBy: "release" }), selection: explainChangelogSelection({ items: [item()], groupBy: "release" }) }));
  const reports: { value: unknown; format: (value: unknown, format: "json" | "toon") => string; decode?: (output: string) => unknown }[] = [
    { value: generated, format: (value, format) => format === "json" ? stringifyUnicodeOutput(value)! : encodeUnicodeOutput(value) },
    { value: drift, format: (value, format) => formatAgentContractDrift(value as AgentContractDriftReport, format) },
    { value: audience, format: (value, format) => formatAudienceContracts(value as AudienceContractReport, format) },
    { value: upgrades, format: (value, format) => formatConsumerUpgrades(value as ConsumerUpgradeReport, format) },
    { value: audit, decode: decodeAudit, format: (value, format) => formatClaimAudit(value as ClaimAuditReport, format) },
    { value: correction, format: (value, format) => formatReleaseCorrection(value as ReleaseCorrection, format) },
    { value: view, format: (value, format) => formatReleaseCorrectionView(value as ReleaseCorrectionView, format) },
  ];
  let attempted = 0;
  assert.doesNotThrow(() => {
  for (const text of strings()) {
    const source = item(text);
    const unicodeId = `source-${text}`;
    const capturedDone = text.length % 2 === 0;
    const capture = { statusSelection: new Map([[unicodeId, capturedDone]]), omittedNonChangeIds: new Set(["foreign-" + unicodeId]) };
    const capturedSource = { ...source, id: unicodeId, status: capturedDone ? "open" : "closed" };
    assert.equal(buildAgentContractDrift({ ...range, ...capture, items: [capturedSource] }).changes.length, Number(capturedDone));
    assert.equal(buildAudienceContracts({ ...capture, items: [capturedSource] }).item_count, Number(capturedDone));
    assert.equal(buildConsumerUpgrades({ ...range, ...capture, audience: "agent-behavior", items: [capturedSource] }).action_count, Number(capturedDone));
    const idReport = buildAgentContractDrift({ ...range, items: [{ ...source, id: unicodeId }] });
    assert.equal(idReport.changes[0].items[0], expected(unicodeId));
    const idActions = buildConsumerUpgrades({ ...range, audience: "agent-behavior", items: [{ ...source, id: unicodeId }] });
    assert.equal(idActions.steps[0].attribution[0].item, expected(unicodeId));
    const legacy = { ...source, close_reason: text, change_facets: [{ audience: "agent-behavior" as const, source: "close_reason" as const }] };
    const sourceNotes = buildAudienceContracts({ items: [legacy] });
    const expectedNotes = buildAudienceContracts({ items: [{ ...legacy, close_reason: expected(text) as string }] });
    assert.deepEqual(sourceNotes, expectedNotes);
    assert.deepEqual(JSON.parse(extensionTestSurface.renderedCommandResult({ text }).output), { text: expected(text) });
    const keyOutput = { [`key-${text}`]: text };
    assert.deepEqual(decodeToon(encodeUnicodeOutput(keyOutput)), expected(keyOutput));
    for (const field of ["assumption", "commands", "evidence"] as const) {
      const base = { id: "obligation", assumption: "Read revision", commands: ["pm apply"], evidence: ["proof"] };
      const declaration = parseAgentObligation({ ...base, [field]: field === "assumption" ? text : [text] });
      assert.deepEqual(declaration[field], field === "assumption" ? expected(text) : [expected(text)]);
    }
    const produced = buildAgentContractDrift({ ...range, items: [source] });
    assert.equal(produced.complete, true); assert.equal(produced.definitions[0].assumption, expected(text));
    for (const format of ["json", "toon"] as const) assert.deepEqual(format === "json" ? JSON.parse(formatAgentContractDrift(produced, format)) : decodeToon(formatAgentContractDrift(produced, format)), produced);
    const notes = buildAudienceContracts({ items: [{ ...source, id: `item-${text}`, type: text, release: text }], groupBy: "release", sectionBy: "type" });
    assert.equal(notes.ledger_sha256, createHash("sha256").update(JSON.stringify(notes.ledger)).digest("hex"));
    assert.deepEqual(decodeToon(formatAudienceContracts(notes, "toon")), notes);
    const actionReport = buildConsumerUpgrades({ ...range, audience: "agent-behavior", items: [source] });
    assert.equal(actionReport.steps[0].title, expected(text)); assert.equal(actionReport.steps[0].body, expected(text));
    for (const report of reports) for (const path of fields(report.value)) {
      const candidate = changed(report.value, path, text); attempted++;
      let json: string | undefined, toon: string | undefined, jsonError: unknown, toonError: unknown;
      try { json = report.format(candidate, "json"); } catch (error) { jsonError = error; }
      try { toon = report.format(candidate, "toon"); } catch (error) { toonError = error; }
      if (jsonError || toonError) {
        assert.ok(jsonError instanceof PmCliError, `${path.join(".")}: JSON must refuse with a typed error`);
        assert.ok(toonError instanceof PmCliError, `${path.join(".")}: TOON must refuse with a typed error`);
        assert.equal(jsonError.code, toonError.code);
      } else {
        assert.deepEqual((report.decode ?? decodeToon)(toon!), JSON.parse(json!));
        assert.deepEqual(JSON.parse(json!), expected(candidate));
      }
    }
  }
  });
  assert.ok(attempted > 30000);
  t.diagnostic(`seed=0x298f16 strings=500 text_field_cases=${attempted}; JSON/TOON producer/refusal parity`);
});

test("Unicode boundary: dynamic keys, shared references, sparse arrays and non-JSON projections stay safe", () => {
  const exact = item(); exact.change_facets![0].obligations![0].assumption = "\ud800";
  exact.change_facets![0].obligations!.push({ id: "sibling", assumption: "Valid sibling", commands: ["pm read"], evidence: ["sibling"] });
  const exactReport = buildAgentContractDrift({ ...range, items: [exact] });
  assert.equal(exactReport.complete, true); assert.equal(exactReport.definitions[0].assumption, "�"); assert.equal(exactReport.changes.length, 2);
  assert.deepEqual(decodeToon(formatAgentContractDrift(exactReport, "toon")), JSON.parse(formatAgentContractDrift(exactReport, "json")));
  const source = item(); source.change_facets![0].obligations!.push({ id: "\ud800", assumption: "Invalid identity", commands: ["pm read"], evidence: ["bad"] });
  const mixed = buildAgentContractDrift({ ...range, items: [source] });
  assert.equal(mixed.complete, false); assert.equal(mixed.omissions.length, 1); assert.deepEqual(mixed.changes.map((row) => row.id), ["obligation"]);
  assert.deepEqual(decodeToon(formatAgentContractDrift(mixed, "toon")), JSON.parse(formatAgentContractDrift(mixed, "json")));
  const linked = () => createChangelog({ items: [{ ...item(), id: "bad-\ud800", itemFolder: "custom-\udfff" }], itemUrlBase: "https://example.invalid/source", itemRefStyle: "toon" }).markdown;
  assert.doesNotThrow(linked); assert.match(linked(), /%EF%BF%BD/);
  assert.equal(formatLocalTimestampDate("123456789😀after"), "123456789😀");
  assert.match(createChangelog({ items: [item()], bodyPreview: 2 }).markdown, /A😀…/);
  const payload = { ["key-\ud800"]: ["\udfff", "\ud83d\ude00", "\r\n\t\u0000"] };
  assert.deepEqual(JSON.parse(stringifyUnicodeOutput(payload)!), expected(payload));
  assert.deepEqual(decodeToon(encodeUnicodeOutput(payload)), expected(payload));
  assert.equal(normalizeUnicodeText("\ud800\ud800\udc00\udc00"), "�\ud800\udc00�");
  const shared = { text: "\ud800" }; const result = normalizeUnicodeOutput([shared, shared]); assert.equal(result[0], result[1]);
  const sparse = new Array(2); sparse[1] = "\ud800"; const fixed = normalizeUnicodeOutput(sparse); assert.equal(0 in fixed, false); assert.equal(fixed.length, 2);
  assert.equal(encodeUnicodeOutput(new Date("2026-10-29")), '"2026-10-29T00:00:00.000Z"');
  assert.deepEqual(decodeToon(encodeUnicodeOutput(new Set(["\ud800"]))), ["�"]);
  assert.match(encodeUnicodeOutput(new Map([["\ud800", "\udfff"]])), /�/);
  for (const value of [{ ["\ud800"]: 1, "�": 2 }, new Map([["\ud800", 1], ["�", 2]])]) for (const render of [encodeUnicodeOutput, stringifyUnicodeOutput]) assert.throws(() => render(value), UnicodeOutputError);
  const nullPrototype = Object.assign(Object.create(null), { text: "\ud800" }); assert.deepEqual(normalizeUnicodeOutput(nullPrototype), { text: "�" });
  assert.deepEqual(normalizeUnicodeOutput({ toJSON: "\ud800" }), { toJSON: "�" });
  assert.equal(JSON.parse(cliTestSurface.errorMessage(new UnicodeOutputError())).error.code, "invalid_unicode_output");
  const self = { text: "\ud800", toJSON() { return this; } }; assert.equal(normalizeUnicodeOutput(self).text, "�");
  assert.equal(normalizeUnicodeOutput(Object.create({ inherited: true })).inherited, true);
  const cycle: { text: string; self?: unknown } = { text: "\ud800" }; cycle.self = cycle; assert.throws(() => stringifyUnicodeOutput(cycle), TypeError);
});

test("Unicode native: non-git SDK and real JSON/TOON CLIs preserve siblings and native source state", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-unicode-native-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, ".agents/pm"); await runInit("unicode", { path: root }, { defaults: true, agentGuidance: "skip" });
  const target = join(root, "extensions/pm-changelog"); mkdirSync(target, { recursive: true });
  cpSync(resolve("dist"), join(target, "dist"), { recursive: true }); cpSync(resolve("manifest.json"), join(target, "manifest.json"));
  writeFileSync(join(target, "package.json"), JSON.stringify({ type: "module" })); symlinkSync(resolve("node_modules"), join(target, "node_modules"), "junction");
  const text = "native \ud800X\udfff \ud83d\ude00\r\n";
  const source = item(text);
  source.change_facets![0].obligations!.push({ id: "sibling", assumption: "Valid sibling", commands: ["pm read"], evidence: ["sibling"] });
  source.change_facets![0].obligations![0].commands = [text]; source.change_facets![0].obligations![0].evidence = [text];
  await runWithActiveExtensions({ path: root }, async () => {
    const create = (facets: unknown) => runCreate({ title: "Unicode fixture", type: "Feature", status: "closed", closeReason: "Delivered", release: "2.0.0", createMode: "progressive",
      field: [`change_facets=${JSON.stringify(facets)}`], unset: ["parent", "goal", "objective", "sprint", "assignee", "reviewer"] }, { path: root, author: "fixture" });
    await assert.rejects(() => create(source.change_facets), (error: unknown) => {
      assert.ok(error instanceof PmCliError); assert.equal(error.code, "text_unpaired_surrogate"); assert.match(error.message, /change_facets\[0\]\.text/); return true;
    });
    assert.equal((await listAllComplete({ includeBody: true }, { pmRoot: root })).items.length, 0);
    await runCreate({ title: "Unicode fixture", type: "Feature", status: "closed", closeReason: "Delivered", release: "2.0.0", createMode: "progressive",
      field: [`change_facets=${JSON.stringify(normalizeUnicodeOutput(source.change_facets))}`], unset: ["parent", "goal", "objective", "sprint", "assignee", "reviewer"] }, { path: root, author: "fixture" });
  });
  const before = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
  assert.equal((before[0] as PmItem).change_facets![0].obligations![0].assumption, expected(text));
  const drift = buildAgentContractDrift({ ...range, items: before }), audience = buildAudienceContracts({ items: before, groupBy: "release" });
  const upgrades = buildConsumerUpgrades({ ...range, audience: "agent-behavior", items: before });
  assert.equal(drift.complete, true); assert.deepEqual(drift.changes.map((row) => row.id), ["obligation", "sibling"]);
  assert.equal(drift.definitions[0].assumption, expected(text));
  const noGit = join(cwd, "bin"); mkdirSync(noGit);
  const childEnv = { PATH: noGit, DO_NOT_TRACK: "1", PM_GLOBAL_PATH: join(cwd, "global"), GIT_CEILING_DIRECTORIES: dirname(cwd) };
  for (const command of ["drift", "contracts", "upgrades"]) for (const format of ["json", "toon"] as const) for (const host of [false, true]) {
    const prefix = host ? [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", root, "changelog", command] : [resolve("dist/cli.js"), command, "--pm-root", root];
    const flags = command === "contracts" ? ["--group-by", "release"] : ["--from", range.from, "--to", range.to, ...(command === "upgrades" ? ["--audience", "agent-behavior"] : [])];
    const result = spawnSync(process.execPath, [...prefix, ...flags, "--format", format], { cwd, env: childEnv, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(format === "json" ? JSON.parse(result.stdout) : decodeToon(result.stdout), command === "drift" ? drift : command === "contracts" ? audience : upgrades);
  }
  assert.deepEqual((await listAllComplete({ includeBody: true }, { pmRoot: root })).items, before);
});
