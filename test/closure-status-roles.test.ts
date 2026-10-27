import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { decode, encode } from "@toon-format/toon";
import { PmClient, normalizeStatusInput, readSettings, resolveRuntimeStatusRegistry, listAllComplete, runCreate, runInit, runWithActiveExtensions, schemaAddStatus } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import extension from "../src/extension.ts";
import { appendReleaseCorrection, auditChangelogClaims, buildAudienceContracts, buildChangelogDocument, buildConsumerUpgrades, createChangelog, createChangelogSummary, createReleaseMilestone, DirectoryReleaseMilestoneStore, explainChangelogSelection, formatAudienceContracts, formatConsumerUpgrades, lintChangelogEntries, parseReleaseMilestone, readAudienceContracts, readConsumerUpgrades, readReleaseCorrectionView, readTrackerReleaseSnapshot, resolveTrackerReleaseHistory, suggestSemver } from "../src/index.ts";
import { countNonChangeClosures, isNonChangeClosure, needsNeutralClosure } from "../src/closure-policy.ts";
import { suggestSemverForItems } from "../src/generator.ts";
import type { GenerateChangelogOptions, PmItem } from "../src/index.ts";
import type { RuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";

/** Create native rows through the SDK with explicit scope and a deliberately misleading vocabulary. */
async function fixture(t: { after(fn: () => void): void }) {
  const cwd = mkdtempSync(join(tmpdir(), "pm-closure-roles-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, ".agents/pm");
  await runInit("role", { path: root }, { defaults: true, agentGuidance: "skip" });
  await schemaAddStatus("delivered", { role: ["terminal", "terminal_done"], alias: ["landed_alias", "constructor"] }, { pmRoot: root });
  await schemaAddStatus("closed_active", { role: ["active"] }, { pmRoot: root });
  await schemaAddStatus("closed_blocked", { role: ["blocked"] }, { pmRoot: root });
  await schemaAddStatus("closed_canceled", { role: ["terminal", "terminal_canceled"] }, { pmRoot: root });
  const registry = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
  const cases = [
    { id: "role-duplicate", title: "Omitted duplicate", status: "delivered", reason: "Duplicate", breaking: true },
    { id: "role-neutral", title: "Investigation ended", status: "delivered", reason: "Investigation complete", breaking: true },
    { id: "role-repair", title: "Parser repair", status: "delivered", reason: "Fixed parser failure", breaking: false },
    { id: "role-active", title: "Active work", status: "closed_active", reason: "Duplicate", breaking: false },
    { id: "role-blocked", title: "Blocked work", status: "closed_blocked", reason: "Duplicate", breaking: false },
    { id: "role-canceled", title: "Canceled work", status: "closed_canceled", reason: "Duplicate", breaking: false },
  ];
  const client = new PmClient({ pmRoot: root, author: "fixture" });
  const extensionRoot = join(root, "extensions/pm-changelog"); mkdirSync(extensionRoot, { recursive: true });
  cpSync(resolve("dist"), join(extensionRoot, "dist"), { recursive: true }); cpSync(resolve("manifest.json"), join(extensionRoot, "manifest.json"));
  writeFileSync(join(extensionRoot, "package.json"), JSON.stringify({ type: "module" })); symlinkSync(resolve("node_modules"), join(extensionRoot, "node_modules"), "junction");
  await runWithActiveExtensions({ path: root }, async () => {
    for (const row of cases) {
      await runCreate({ id: row.id, title: row.title, type: "Issue", status: row.status, closeReason: row.reason, createMode: "progressive", release: "2.0.0", tags: row.breaking ? "breaking" : undefined,
      field: [`change_facets=${JSON.stringify([{ audience: "api-user", text: row.title, breaking: true, upgrade_actions: [{ id: row.id, title: "Follow published guidance", requires: [] }] }])}`], unset: ["parent", "goal", "objective", "sprint"] }, { path: root, author: "fixture" });
      await client.update(row.id, { closeReason: row.reason, release: "2.0.0", unset: ["parent", "goal", "objective", "sprint"] });
      assert.equal((await client.get(row.id, { full: true })).item.close_reason, row.reason);
    }
  });
  const snapshot = await readTrackerReleaseSnapshot(root);
  const store = new DirectoryReleaseMilestoneStore(root);
  const capture = await createReleaseMilestone(store, "v1", { ...snapshot, capturedAt: "2026-10-02T00:00:00Z" });
  const live = await listAllComplete({ includeBody: false }, { pmRoot: root });
  return { cwd, root, client, store, capture, registry, items: live.items };
}

/** Assert independent model outcomes across every generator projection without modifying native rows. */
function assertPolicy(options: GenerateChangelogOptions): void {
  const nonChanges = options.items.some((item) => item.id === "role-canceled") ? 2 : 1;
  const generated = createChangelog({ ...options, breakingChanges: true });
  assert.equal(generated.excludedNonChangeCount, nonChanges);
  assert.equal(generated.itemCount, 2);
  assert.doesNotMatch(generated.markdown, /Omitted duplicate|### Breaking Changes|Active work|Blocked work|Canceled work/);
  assert.match(generated.markdown, /### Closed\n\n- Closed: Investigation ended/);
  assert.match(generated.markdown, /### Fixed\n\n- Parser repair/);
  const document = buildChangelogDocument({ ...options, breakingChanges: true, suggestSemver: true });
  assert.equal(document.excluded_non_change_count, nonChanges); assert.equal(document.item_count, 2);
  assert.deepEqual(document.releases.flatMap((release) => release.breaking_changes ?? []), []);
  assert.deepEqual(document.suggested_semver?.counts, { breaking: 0, feature: 0, fix: 1, other: 0 });
  const summary = createChangelogSummary(options);
  assert.deepEqual(summary.map((row) => row.id).sort(), ["role-neutral", "role-repair"]);
  assert.equal(summary.find((row) => row.id === "role-neutral")!.category, "Closed");
  const diagnostics = explainChangelogSelection(options);
  assert.equal(diagnostics.excluded_counts.non_change, nonChanges);
  assert.equal(diagnostics.stage_counts.visible_items, 2);
  assert.deepEqual(suggestSemver(options).counts, { breaking: 0, feature: 0, fix: 1, other: 0 });
  assert.deepEqual(suggestSemverForItems(options.items.filter((item) => ["role-duplicate", "role-neutral", "role-repair"].includes(item.id!)), options).counts, { breaking: 0, feature: 0, fix: 1, other: 0 });
  const audit = auditChangelogClaims(options);
  assert.doesNotMatch(JSON.stringify(audit), /Omitted duplicate/);
  for (const sectionBy of ["type", "status", "label"] as const) {
    const grouped = createChangelog({ ...options, sectionBy });
    assert.match(grouped.markdown, /### Closed\n\n- Closed: Investigation ended/);
    assert.doesNotMatch(grouped.markdown, /Omitted duplicate/);
  }
}

test("captured custom done closures use one disposition/evidence policy after live roles change", async (t) => {
  const { root, client, capture, registry } = await fixture(t);
  const native = (await client.get("role-duplicate", { full: true })).item;
  const options = resolveTrackerReleaseHistory([capture], [], registry);
  assertPolicy(options);
  assert.equal(countNonChangeClosures(options.items, options), 1);
  const duplicate = options.items.find((item) => item.id === "role-duplicate")!;
  assert.equal(isNonChangeClosure(duplicate, options), true);
  assert.equal(isNonChangeClosure(duplicate, { statusRegistry: registry, statusSelection: new Map([[duplicate.id!, false]]) }), false);
  assert.equal(isNonChangeClosure(duplicate, { statusRegistry: registry, statusSelection: new Map() }), true);
  assert.equal(createChangelog({ items: [{ id: "legacy-unknown", title: "Legacy explicit scope", type: "Feature", status: "  __proto__\r\n" }], includeStatuses: ["__PROTO__"], statusRegistry: registry }).itemCount, 1);
  assert.equal(createChangelog({ items: [{ id: "legacy-missing", title: "Missing status", type: "Feature" }], includeStatuses: ["delivered"], statusRegistry: registry }).itemCount, 0);
  assert.equal(needsNeutralClosure(options.items.find((item) => item.id === "role-neutral")!, options), true);
  const before = createChangelog(options).markdown;
  await schemaAddStatus("delivered", { role: ["active"], alias: ["renamed_alias"] }, { pmRoot: root });
  await schemaAddStatus("closed_active", { role: ["terminal", "terminal_done"] }, { pmRoot: root });
  const current = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
  const frozen = resolveTrackerReleaseHistory([capture], [], current);
  assert.equal(createChangelog(frozen).markdown, before); assertPolicy(frozen);
  await assert.rejects(readReleaseCorrectionView(root, "v1", "role-duplicate"), { code: "correction_missing" });
  await assert.rejects(appendReleaseCorrection(root, { schema: 1, release: "v1", item: "role-duplicate", milestone: capture.fingerprint, id: "bad", supersedes: "", expectedRevision: capture.fingerprint, wording: "Not a published change", evidence: ["docs/release-corrections.md"] }), { code: "correction_missing" });
  assert.deepEqual((await client.get("role-duplicate", { full: true })).item, native);
  assert.equal((await client.notes("role-duplicate")).count, 0);
  assert.equal((await readReleaseCorrectionView(root, "v1", "role-neutral")).original, "Investigation ended");
});

test("500 seeded role/alias and round-trip sequences preserve SDK-read state and all output policies", async (t) => {
  const { root, client, capture, registry, items } = await fixture(t);
  const native = await Promise.all(items.map(async (item) => (await client.get(item.id!, { full: true })).item));
  const pool: { registry: RuntimeStatusRegistry; done: boolean; terminal: boolean; alias: string }[] = [];
  const roleSets = [["terminal", "terminal_done"], ["active"], ["blocked"], ["terminal", "terminal_canceled"]];
  for (let index = 0; index < 8; index++) {
    const kind = index % roleSets.length;
    const alias = `seeded_alias_${Math.imul(index + 1, 7919)}`;
    await schemaAddStatus("delivered", { role: roleSets[kind], alias: [alias, "constructor"] }, { pmRoot: root });
    const configured = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
    assert.equal(configured.terminal_done_statuses.has("delivered"), kind === 0);
    pool.push({ registry: configured, done: kind === 0, terminal: kind === 0 || kind === 3, alias });
  }
  let seed = 0x291f3;
  for (let sequence = 0; sequence < 500; sequence++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const selected = pool[(seed >>> 8) % pool.length];
    const variant = ["delivered", `  ${selected.alias.toUpperCase()}\r\n`, "constructor"][(seed >>> 16) % 3];
    assert.equal(normalizeStatusInput(variant, selected.registry), "delivered");
    const source = seed & 16 ? JSON.parse(JSON.stringify(capture)) : decode(encode(capture));
    const frozen = resolveTrackerReleaseHistory([parseReleaseMilestone(source)], [], selected.registry);
    const live = { items: items.map((item) => item.status === "delivered" ? { ...item, status: variant } : item), statusRegistry: selected.registry };
    assertPolicy(frozen);
    if (selected.done) {
      assertPolicy(live);
      const filtered = createChangelog({ ...live, includeStatuses: [variant] });
      assert.equal(filtered.itemCount, 2); assert.equal(filtered.excludedNonChangeCount, 2);
    } else {
      assert.equal(createChangelog(live).itemCount, 0);
      assert.equal(createChangelog(live).excludedNonChangeCount, selected.terminal ? 2 : 1);
      assert.equal(buildChangelogDocument(live).item_count, 0);
      assert.equal(createChangelogSummary(live).length, 0);
      assert.equal(explainChangelogSelection(live).stage_counts.visible_items, 0);
      assert.equal(suggestSemver(live).bump, "none");
    }
    const contracts = buildAudienceContracts({ items: live.items, statusRegistry: selected.registry });
    assert.deepEqual(contracts.ledger.map((row) => row.item).sort(), selected.done ? ["role-neutral", "role-repair"] : []);
    assert.equal(contracts.note_count, selected.done ? 2 : 0);
    for (const format of ["json", "toon"] as const) {
      const serialized = formatAudienceContracts(contracts, format);
      assert.deepEqual(format === "json" ? JSON.parse(serialized) : decode(serialized), contracts);
    }
    if (sequence % 100 === 0) assert.deepEqual(await Promise.all(items.map(async (item) => (await client.get(item.id!, { full: true })).item)), native);
  }
  const lint = { ...items.find((item) => item.id === "role-repair")!, title: "Export crashes", close_reason: undefined, files: [{ path: "src/parser.ts" }] };
  assert.equal(lintChangelogEntries({ items: [lint], statusRegistry: registry }).length, 1);
  const upgrades = buildConsumerUpgrades({ items: [...items], statusRegistry: registry, audience: "api-user", from: "1.0.0", to: "2.0.0" });
  assert.equal(upgrades.action_count, 2);
  assert.doesNotMatch(JSON.stringify(upgrades), /role-duplicate|role-active|role-blocked|role-canceled/);
  for (const format of ["json", "toon"] as const) {
    const serialized = formatConsumerUpgrades(upgrades, format);
    assert.deepEqual(format === "json" ? JSON.parse(serialized) : decode(serialized), upgrades);
  }
  t.diagnostic("seed=0x291f3 sequences=500; SDK registry aliases and frozen JSON/TOON captures; model closure categories, counts, semver and native SDK state");
});

/** Decode either a structured host result or the host's intentionally rendered envelope. */
function hostValue(value: unknown): unknown {
  return value && typeof value === "object" && "output" in value && typeof value.output === "string" ? JSON.parse(value.output) : value;
}

test("host and standalone generation, export, summary, audit, contracts and upgrades agree without git", async (t) => {
  const { cwd, root, capture, items } = await fixture(t);
  const noGit = join(cwd, "bin"); mkdirSync(noGit);
  const env = { ...process.env, PATH: noGit, PM_PATH: root, PM_AUTHOR: "fixture", PM_GLOBAL_PATH: join(cwd, "global"), GIT_CEILING_DIRECTORIES: dirname(cwd), DO_NOT_TRACK: "1" };
  const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] }); assert.deepEqual(activation.failed, []);
  for (const milestones of [false, true]) {
    for (const mode of [["--changelog-json", "--suggest-semver", "--breaking-changes"], ["--summary", "--format", "json"], ["--suggest-semver", "--explain"]]) {
      const result = spawnSync(process.execPath, [resolve("dist/cli.js"), "--pm-root", root, ...(milestones ? ["--milestones"] : []), ...mode], { cwd, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout) as unknown;
      assert.doesNotMatch(JSON.stringify(output), /Omitted duplicate/);
      if (mode.includes("--changelog-json")) {
        const doc = output as ReturnType<typeof buildChangelogDocument>;
        assert.equal(doc.item_count, 2); assert.equal(doc.excluded_non_change_count, 2); assert.equal(doc.suggested_semver?.bump, "patch");
      }
    }
    const host = await runRegisteredCommandForTest(activation.commands, { command: "changelog generate", pmRoot: root, options: { milestones, stdout: true } });
    assert.ok(host.result && typeof host.result === "object" && "changelog" in host.result); assert.match(String(host.result.changelog), /Closed: Investigation ended/); assert.doesNotMatch(String(host.result.changelog), /Omitted duplicate/);
  }
  // External JSON needs the same configured registry as native reads; aliases normalize on both sides.
  const external = JSON.stringify(items.map((item) => item.status === "delivered" ? { ...item, status: "  CONSTRUCTOR\r\n" } : item));
  const inputPath = join(cwd, "external.json"); writeFileSync(inputPath, external);
  for (const input of [["--input", inputPath], ["--stdin"]]) {
    const result = spawnSync(process.execPath, [resolve("dist/cli.js"), ...input, "--pm-root", root, "--changelog-json", "--status", "landed_alias"], { cwd, env, input: external, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const document = JSON.parse(result.stdout) as ReturnType<typeof buildChangelogDocument>;
    assert.equal(document.item_count, 2); assert.equal(document.excluded_non_change_count, 2);
    assert.doesNotMatch(JSON.stringify(document), /Omitted duplicate/); assert.match(JSON.stringify(document), /Closed: Investigation ended/);
  }
  const defaults = spawnSync(process.execPath, [resolve("dist/cli.js"), "--input", inputPath, "--changelog-json"], { cwd, env, encoding: "utf8" });
  assert.equal(defaults.status, 0, defaults.stderr); assert.equal(JSON.parse(defaults.stdout).item_count, 0);
  const exported = hostValue((await runRegisteredCommandForTest(activation.commands, { command: "changelog export", pmRoot: root, options: { format: "json" } })).result) as { item_count: number; excluded_non_change_count: number; markdown: string };
  assert.equal(exported.item_count, 2); assert.equal(exported.excluded_non_change_count, 2); assert.doesNotMatch(exported.markdown, /Omitted duplicate/);
  const contracts = await readAudienceContracts(root);
  assert.deepEqual(contracts.ledger.map((row) => row.item).sort(), ["role-neutral", "role-repair"]);
  assert.doesNotMatch(JSON.stringify(await readConsumerUpgrades(root, { audience: "api-user", from: "1.0.0", to: "2.0.0" })), /role-duplicate/);
  for (const [command, options] of [["changelog contracts", { format: "json" }], ["changelog upgrades", { audience: "api-user", from: "1.0.0", to: "2.0.0", format: "json" }]] as const) {
    const result = await runRegisteredCommandForTest(activation.commands, { command, pmRoot: root, options }); assert.doesNotMatch(JSON.stringify(hostValue(result.result)), /role-duplicate/);
  }
  await schemaAddStatus("delivered", { role: ["active"] }, { pmRoot: root });
  const frozen = resolveTrackerReleaseHistory([capture], [], resolveRuntimeStatusRegistry((await readSettings(root)).schema));
  assertPolicy(frozen);
});
