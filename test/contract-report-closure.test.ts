import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { listAllComplete, runCreate, runInit, runWithActiveExtensions } from "@unbrained/pm-cli/sdk";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";
import { buildAgentContractDrift, buildAudienceContracts, buildChangelogDocument, buildConsumerUpgrades, formatAgentContractDrift, formatAudienceContracts, formatConsumerUpgrades, readAgentContractDrift, readConsumerUpgrades } from "../src/index.ts";
import { isContractReleaseAfter, parseContractRelease, parseContractReleaseHeading } from "../src/contract-versions.ts";
import type { AgentContractDriftReport, AgentObligation, ChangeFacet, PmItem } from "../src/index.ts";

const interval = { from: "1.0.0", to: "2.0.0" };
/** Native-shaped fixtures contain only explicitly authored metadata; builders must not mutate them. */
function change(id: string, release: string, facets: unknown): PmItem {
  return { id, title: "Declared contract", type: "Feature", status: "closed", release, change_facets: facets as ChangeFacet[] };
}
/** Produce all valid records through the existing strict declaration schema domain. */
function declaration(assumption = "Read the target revision"): AgentObligation {
  return { id: "shared", assumption, commands: ["pm example apply"], evidence: ["seed"] };
}
/** Pack many bounded declarations into bounded facets without requiring thousands of native writes. */
function largeFacets(removed = false, assumption = "Read the target revision"): ChangeFacet[] {
  const declarations: AgentObligation[] = Array.from({ length: 1563 }, (_, index) => ({ ...(!removed ? declaration(assumption) : { id: "shared", removed: true as const }),
    evidence: Array.from({ length: 64 }, (_, offset) => `e${(index * 64 + offset).toString(36)}`) }));
  const facets: ChangeFacet[] = [];
  for (let offset = 0; offset < declarations.length; offset += 256) facets.push({ audience: "agent-behavior", text: "Declared contract", obligations: declarations.slice(offset, offset + 256) });
  return facets;
}
/** Every producer result must be accepted unchanged by every formatter/decoder pair. */
function roundTrip(report: AgentContractDriftReport): void {
  for (const format of ["json", "toon"] as const) {
    assert.doesNotThrow(() => {
      const output = formatAgentContractDrift(report, format);
      assert.deepEqual(format === "json" ? JSON.parse(output) : decodeToon(output), report);
    });
  }
}

test("producer closure: aggregate provenance above 100000 survives every transition and encoding", () => {
  const items = [change("baseline", "1.0.0", largeFacets()), change("same", "2.0.0", largeFacets()),
    change("changed", "3.0.0", largeFacets(false, "Read history and revision")), change("removed", "4.0.0", largeFacets(true)),
    change("added", "5.0.0", largeFacets())];
  const report = buildAgentContractDrift({ from: "1.0.0", to: "5.0.0", items });
  assert.deepEqual(report.changes.map((row) => row.kind), ["changed", "removed", "added"]);
  for (const row of [...report.baseline, ...report.unchanged, ...report.changes]) {
    assert.equal(row.evidence.length, 100032);
    assert.equal(new Set(row.evidence).size, 100032);
    assert.equal(row.items.length, 1);
  }
  roundTrip(report);
  assert.deepEqual(buildAgentContractDrift({ from: "1.0.0", to: "5.0.0", items: [...items].reverse() }), report);
  assert.equal(items[0].change_facets![0].obligations![0].evidence.length, 64);
});

test("producer closure: item-level plus record-level omissions and native IDs share formatter domains", () => {
  const roots = Array.from({ length: 50000 }, (_, index) => change(`invalid-${index}`, "2.0.0", null));
  const facets = Array.from({ length: 200 }, () => ({ audience: "agent-behavior", text: "Legacy prose" }));
  const records = Array.from({ length: 500 }, (_, index) => change(`legacy-${index}`, "2.0.0", facets));
  const report = buildAgentContractDrift({ ...interval, items: [...roots, ...records] });
  assert.equal(report.omissions.length, 150000);
  roundTrip(report);
  const longId = `native-${"x".repeat(4096)}`;
  const native = buildAgentContractDrift({ ...interval, items: [change(longId, "2.0.0", [{ audience: "agent-behavior", text: "Explicit", obligations: [declaration(), null] }])] });
  assert.deepEqual(native.changes[0].items, [longId]); assert.equal(native.omissions[0].item, longId);
  roundTrip(native);
});

test("producer closure: derived output bounds still reject oversized external reports", () => {
  const report = buildAgentContractDrift({ ...interval, items: [change("valid", "2.0.0", [{ audience: "agent-behavior", text: "Explicit", obligations: [declaration()] }])] });
  for (const format of ["json", "toon"] as const) {
    assert.throws(() => formatAgentContractDrift({ ...report, changes: [{ ...report.changes[0], evidence: new Array(100000 * 64 + 1) }] }, format), /invalid_drift_report/);
    assert.throws(() => formatAgentContractDrift({ ...report, complete: false, omissions: new Array(100000 * 2 + 1) }, format), /invalid_drift_report/);
  }
});

test("producer closure: orphan omissions retain each contributor's actual coordinates under permutations", () => {
  const tombstone = { id: "orphan", removed: true, evidence: ["retired"] };
  const items = [change("z-first", "2.0.0", [{ audience: "operator", text: "Unrelated" }, { audience: "agent-behavior", text: "Retired", obligations: [tombstone] }]),
    change("a-second", "2.0.0", [{ audience: "agent-behavior", text: "Retired", obligations: [tombstone, tombstone] }])];
  const report = buildAgentContractDrift({ ...interval, items });
  assert.deepEqual(report.omissions, [
    { item: "a-second", facet: 0, obligation: 0, reason: "orphan_removal" },
    { item: "a-second", facet: 0, obligation: 1, reason: "orphan_removal" },
    { item: "z-first", facet: 1, obligation: 0, reason: "orphan_removal" },
  ]);
  assert.deepEqual(buildAgentContractDrift({ ...interval, items: [...items].reverse() }), report);
  roundTrip(report);
});

/** Fixed seed generates unrelated releases and adversarial facet shapes, independently of selection logic. */
function random(seed: number): () => number {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 8; };
}

test("release scope: 500 future-metadata variants cannot change reports, errors, budgets or either encoding", () => {
  const current = change("current", "2.0.0", [
    { audience: "agent-behavior", text: "Explicit", obligations: [declaration()] },
    { audience: "operator", text: "Explicit", breaking: true, upgrade_actions: [{ id: "upgrade", title: "Read revision", requires: [] }] },
  ]);
  const expectedDrift = buildAgentContractDrift({ ...interval, items: [current] });
  const expectedUpgrades = buildConsumerUpgrades({ ...interval, audience: "operator", items: [current] });
  const expectedAudience = buildAudienceContracts({ items: [current], groupBy: "release", untilVersion: "2.0.0" });
  const malformed: unknown[] = [null, undefined, Infinity, NaN, {}, "foreign", [null], new Array(2), Array(257).fill(null),
    [{ audience: "operator", text: "X", breaking: true, upgrade_actions: "bad" }],
    [{ audience: "agent-behavior", obligations: "bad" }],
    [{ audience: "operator", text: "Future", breaking: true, upgrade_actions: [{ id: "upgrade", title: "Conflicting future assumption", requires: [] }] }]];
  const next = random(0x298b0a), seen = new Set<number>();
  for (let index = 0; index < 500; index++) {
    const release = ["v3.0.0", "2.0.0-1", "2026.10.28-1"][next() % 3], variant = next() % malformed.length;
    seen.add(variant);
    const future = change(`future-${index}`, release, malformed[variant]);
    const items = next() % 2 ? [future, current] : [current, future];
    assert.doesNotThrow(() => {
      const drift = buildAgentContractDrift({ ...interval, items });
      const upgrades = buildConsumerUpgrades({ ...interval, audience: "operator", items });
      const audience = buildAudienceContracts({ items, groupBy: "release", untilVersion: "v2.0.0" });
      assert.deepEqual(drift, expectedDrift); assert.deepEqual(upgrades, expectedUpgrades); assert.deepEqual(audience, expectedAudience);
      for (const format of ["json", "toon"] as const) {
        assert.equal(formatAgentContractDrift(drift, format), formatAgentContractDrift(expectedDrift, format));
        assert.equal(formatConsumerUpgrades(upgrades, format), formatConsumerUpgrades(expectedUpgrades, format));
        assert.equal(formatAudienceContracts(audience, format), formatAudienceContracts(expectedAudience, format));
      }
    });
  }
  assert.equal(seen.size, malformed.length);
  const overBudget = Array.from({ length: 400 }, (_, index) => change(`budget-${index}`, "3.0.0", Array(256).fill(null)));
  assert.deepEqual(buildAgentContractDrift({ ...interval, items: [current, ...overBudget] }), expectedDrift);
  for (const options of [{ untilVersion: "bad" }, { untilVersion: "2.0.0" }, { untilVersion: "2.0.0", groupBy: "milestone" as const }]) {
    assert.throws(() => buildAudienceContracts({ ...options, items: [current] }), /invalid_contract_options/);
  }
  assert.throws(() => buildAudienceContracts({ items: [current, change("invalid", "2.0.0", null)], groupBy: "release", untilVersion: "2.0.0" }), /invalid_facets/);
});

test("release headings: 500 generated window and persisted heading variants share numeric scope before validation", () => {
  const facet = [{ audience: "agent-behavior", text: "Explicit", obligations: [declaration()], breaking: true,
    upgrade_actions: [{ id: "upgrade", title: "Read revision", requires: [] }] }];
  const current = change("current", "2.0.0", facet);
  const expectedDrift = buildAgentContractDrift({ ...interval, items: [current] });
  const expectedUpgrades = buildConsumerUpgrades({ ...interval, audience: "agent-behavior", items: [current] });
  const next = random(0x298da7e), seen = new Set<number>();
  const decorate = (version: string, variant: number): string => [version, `${version} - 2026-10-29`,
    `v${version} - 2026-10-29`, ` [v${version}] - 2026-10-29 `,
    `[${version}](https://example.invalid/release) - 2026-10-29`, ` V${version}  -  2026-10-29 `][variant];
  for (let index = 0; index < 500; index++) {
    const variant = next() % 6; seen.add(variant);
    const heading = decorate("3.0.0", variant), present = decorate("2.0.0", next() % 6);
    const bad = [null, [null], { invalid: true }, [{ audience: "operator", text: "Future published prose" }], facet][next() % 5];
    const future = change("future", "3.0.0", bad);
    const windows = [{ heading, releaseTag: "v3.0.0" }, { heading: present, releaseTag: "v2.0.0" }];
    const options = { groupBy: "release" as const, untilVersion: "2.0.0", releaseWindows: windows };
    const expected = buildAudienceContracts({ ...options, items: [current] });
    const items = next() % 2 ? [current, future] : [future, current];
    assert.doesNotThrow(() => {
      const lower = buildChangelogDocument({ items: [...items, change("past", "1.0.0", facet)], sinceVersion: "2.0.0",
        releaseWindows: [...windows, { heading: decorate("1.0.0", variant), releaseTag: "v1.0.0" }] });
      assert.deepEqual(lower.releases.flatMap((release) => release.sections.flatMap((section) => section.items.map((item) => item.id))).sort(), ["current", "future"]);
      const audience = buildAudienceContracts({ ...options, items });
      assert.deepEqual(audience, expected); assert.equal(audience.item_count, 1);
      assert.equal(audience.ledger[0].release, present);
      // Persisted native release headings use the same scope grammar as releaseWindows.
      const decorated = [change("current", present, facet), change("future", heading, bad)];
      const drift = buildAgentContractDrift({ ...interval, items: decorated });
      const upgrades = buildConsumerUpgrades({ ...interval, audience: "agent-behavior", items: decorated });
      assert.deepEqual(drift, expectedDrift); assert.deepEqual(upgrades, expectedUpgrades);
      for (const format of ["json", "toon"] as const) {
        assert.equal(formatAudienceContracts(audience, format), formatAudienceContracts(expected, format));
        assert.equal(formatAgentContractDrift(drift, format), formatAgentContractDrift(expectedDrift, format));
        assert.equal(formatConsumerUpgrades(upgrades, format), formatConsumerUpgrades(expectedUpgrades, format));
      }
      assert.equal(isContractReleaseAfter(heading, "2.0.0"), true);
      assert.equal(isContractReleaseAfter(present, "2.0.0"), false);
    });
  }
  assert.equal(seen.size, 6);
  for (const legacy of [undefined, null, 3, "Unreleased", "legacy - 2026-10-29", "1.0.0-rc.1 - 2026-10-29"]) {
    assert.equal(parseContractReleaseHeading(legacy), undefined);
    assert.equal(isContractReleaseAfter(legacy, "2.0.0"), false);
  }
  // Range arguments remain strict; presentation decoration is accepted only on stored headings.
  for (const input of ["2.0.0 - 2026-10-29", "[2.0.0]", " 2.0.0 ", "V2.0.0"]) {
    assert.equal(parseContractRelease(input), undefined);
    assert.throws(() => buildAgentContractDrift({ from: "1.0.0", to: input, items: [] }), /invalid_drift_options/);
    assert.throws(() => buildConsumerUpgrades({ from: "1.0.0", to: input, audience: "operator", items: [] }), /invalid_upgrade_options/);
    assert.throws(() => buildAudienceContracts({ items: [], groupBy: "release", untilVersion: input }), /invalid_contract_options/);
  }
  assert.throws(() => buildAudienceContracts({ items: [change("bad", "2.0.0", null)], groupBy: "release", untilVersion: "2.0.0",
    releaseWindows: [{ heading: "2.0.0 - 2026-10-29", releaseTag: "v2.0.0" }] }), /invalid_facets/);
  assert.equal(buildAudienceContracts({ items: [current], groupBy: "release", untilVersion: "2.0.0",
    releaseWindows: [{ heading: "legacy", releaseTag: "v2.0.0" }] }).item_count, 1);
  const unbounded = { groupBy: "release" as const, releaseWindows: [{ heading: "3.0.0 - 2026-10-29", releaseTag: "v3.0.0" }] };
  assert.equal(buildAudienceContracts({ ...unbounded, items: [change("future", "3.0.0", facet)] }).item_count, 1);
  assert.throws(() => buildAudienceContracts({ ...unbounded, items: [change("future", "3.0.0", null)] }), /invalid_facets/);
});

test("release scope and producer closure: SDK and both real CLIs agree in a non-git tracker", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-contract-closure-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, ".agents/pm");
  await runInit("contract", { path: root }, { defaults: true, agentGuidance: "skip" });
  const target = join(root, "extensions/pm-changelog"); mkdirSync(target, { recursive: true });
  cpSync(resolve("dist"), join(target, "dist"), { recursive: true }); cpSync(resolve("manifest.json"), join(target, "manifest.json"));
  writeFileSync(join(target, "package.json"), JSON.stringify({ type: "module" })); symlinkSync(resolve("node_modules"), join(target, "node_modules"), "junction");
  await runWithActiveExtensions({ path: root }, async () => {
    for (const item of [change("large", "2.0.0", largeFacets()), change("future", "3.0.0", [null]), change("dated-future", "3.0.0 - 2026-10-29", [null])]) await runCreate({ id: item.id, title: item.title,
      type: "Feature", status: "closed", closeReason: "Delivered", release: item.release, createMode: "progressive", field: [`change_facets=${JSON.stringify(item.change_facets)}`],
      unset: ["parent", "goal", "objective", "sprint", "assignee", "reviewer"] }, { path: root, author: "fixture" });
  });
  const before = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
  const drift = await readAgentContractDrift(root, interval), upgrades = await readConsumerUpgrades(root, { ...interval, audience: "operator" });
  assert.equal(drift.complete, true); assert.equal(drift.changes[0].evidence.length, 100032);
  const noGit = join(cwd, "bin"); mkdirSync(noGit);
  const childEnv = { PATH: noGit, DO_NOT_TRACK: "1", PM_GLOBAL_PATH: join(cwd, "global"), GIT_CEILING_DIRECTORIES: dirname(cwd) };
  for (const format of ["json", "toon"] as const) for (const command of ["drift", "upgrades"]) for (const prefix of [
    [resolve("dist/cli.js"), command, "--pm-root", root], [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", root, "changelog", command],
  ]) {
    const args = [...prefix, "--from", interval.from, "--to", interval.to, "--format", format, ...(command === "upgrades" ? ["--audience", "operator"] : [])];
    const result = spawnSync(process.execPath, args, { cwd, env: childEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(format === "json" ? JSON.parse(result.stdout) : decodeToon(result.stdout), command === "drift" ? drift : upgrades);
  }
  assert.deepEqual((await listAllComplete({ includeBody: true }, { pmRoot: root })).items, before);
});
