/** Exercise the packed correction feature through real npm/Bun installation and launcher modes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runInit, runCreate, runWithActiveExtensions, listAllComplete, PmClient, schemaAddStatus } from "@unbrained/pm-cli/sdk";
import { decode } from "@toon-format/toon";
import { readConsumerUpgrades, readAgentContractDrift, readAudienceContracts, normalizeUnicodeText, appendReleaseCorrection, createReleaseMilestone, DirectoryReleaseMilestoneStore, readReleaseCorrectionView, readTrackerReleaseSnapshot } from "../src/index.ts";
import type { ChangelogDocument, ChangelogSummaryEntry, ChangelogSelectionReport, SemverSuggestion, ReleaseMilestone } from "../src/index.ts";

const scratch = mkdtempSync(join(tmpdir(), "pm-correction-pack-"));
const repository = resolve(import.meta.dirname, "..");
const pinned = (JSON.parse(readFileSync(join(repository, "package.json"), "utf8")) as { devDependencies: Record<string, string> }).devDependencies["@unbrained/pm-cli"];
const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NPM_CONFIG_PREFER_OFFLINE: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false", NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull, DO_NOT_TRACK: "1", GIT_CEILING_DIRECTORIES: dirname(scratch), BUN_INSTALL: join(scratch, "bun-global"), BUN_INSTALL_CACHE_DIR: join(scratch, "bun-cache") };
/** Capture commands without publishing installer noise or scratch paths. */
function run(binary: string, args: string[], cwd = scratch): string {
  return execFileSync(binary, args, { cwd, env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024, timeout: 180000 });
}
try {
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], repository)) as { filename: string }[];
  const archive = join(scratch, packed[0].filename);
  const archiveSha512 = createHash("sha512").update(readFileSync(archive)).digest("hex");
  const root = join(scratch, "tracker/.agents/pm");
  await runInit("accept", { path: root }, { defaults: true, agentGuidance: "skip" });
  const legacy = JSON.parse(readFileSync(join(repository, "test/fixtures/milestones-v1-publication.json"), "utf8")) as ReleaseMilestone[];
  for (const capture of legacy) await new DirectoryReleaseMilestoneStore(root).publish(capture.name, capture);
  await runCreate({ id: "old-claim", title: "Legacy released wording", type: "Feature", status: "closed", closeReason: "Delivered", createMode: "progressive", unset: ["parent", "goal", "objective", "sprint", "release"] }, { path: root, author: "acceptance" });
  const legacyView = await readReleaseCorrectionView(root, "legacy-v2", "old-claim");
  await appendReleaseCorrection(root, { schema: 1, release: "legacy-v2", item: "old-claim", milestone: legacyView.milestone, expectedRevision: legacyView.revision, id: "legacy-correction", supersedes: "", wording: "Legacy correction retained", evidence: ["docs/release-corrections.md"] });
  await schemaAddStatus("mutable_draft", { role: ["active"] }, { pmRoot: root });
  await schemaAddStatus("mutable_done", { role: ["terminal", "terminal_done"] }, { pmRoot: root });
  await runCreate({ id: "accept-claim", title: "Unpublished acceptance draft", type: "Feature", status: "mutable_draft", createMode: "progressive", unset: ["parent", "goal", "objective", "sprint", "release"] }, { path: root, author: "acceptance" });
  const draft = await createReleaseMilestone(new DirectoryReleaseMilestoneStore(root), "draft", await readTrackerReleaseSnapshot(root));
  const client = new PmClient({ pmRoot: root, author: "acceptance" });
  await client.update("accept-claim", { title: "Published acceptance claim", status: "mutable_done", closeReason: "Delivered", unset: ["parent", "goal", "objective", "sprint", "release"] });
  for (const row of [
    { id: "accept-duplicate", title: "Packed omitted duplicate", reason: "Duplicate", tags: "breaking" },
    { id: "accept-neutral", title: "Packed neutral closure", reason: "Investigation complete", tags: "breaking" },
    { id: "accept-repair", title: "Packed parser repair", reason: "Fixed parser failure", tags: "" },
  ]) {
    await runCreate({ id: row.id, title: row.title, type: "Issue", status: "mutable_done", tags: row.tags, createMode: "progressive", unset: ["parent", "goal", "objective", "sprint", "release"] }, { path: root, author: "acceptance" });
    await client.update(row.id, { closeReason: row.reason, unset: ["parent", "goal", "objective", "sprint", "release"] });
    assert.equal((await client.get(row.id, { full: true })).item.close_reason, row.reason);
  }
  const published = await createReleaseMilestone(new DirectoryReleaseMilestoneStore(root), "v1", { ...(await readTrackerReleaseSnapshot(root)), capturedAt: new Date(Date.parse(draft.capturedAt) + 1000).toISOString() });
  await client.update("accept-claim", { title: "Edited wording captured later", unset: ["parent", "goal", "objective", "sprint", "release"] });
  const later = await createReleaseMilestone(new DirectoryReleaseMilestoneStore(root), "a-later", { ...(await readTrackerReleaseSnapshot(root)), capturedAt: new Date(Date.parse(published.capturedAt) + 1000).toISOString() });
  await appendReleaseCorrection(root, { schema: 1, release: "v1", item: "accept-claim", milestone: published.fingerprint, id: "before-role-edit", supersedes: "", expectedRevision: published.fingerprint, wording: "Correction recorded before registry edits", evidence: ["docs/release-corrections.md"] });
  await schemaAddStatus("mutable_draft", { role: ["terminal", "terminal_done"] }, { pmRoot: root });
  await schemaAddStatus("mutable_done", { role: ["blocked"] }, { pmRoot: root });
  // A separate native tracker preserves every earlier assertion while exercising omitted-then-repaired ownership.
  const lifecycleRoot = join(scratch, "lifecycle/.agents/pm");
  await runInit("later", { path: lifecycleRoot }, { defaults: true, agentGuidance: "skip" });
  await schemaAddStatus("custom_done", { role: ["terminal", "terminal_done"] }, { pmRoot: lifecycleRoot });
  await runCreate({ id: "later-repair", title: "Packed omitted duplicate", type: "Issue", status: "open", createMode: "progressive", unset: ["parent", "goal", "objective", "sprint", "release"] }, { path: lifecycleRoot, author: "acceptance" });
  const lifecycleClient = new PmClient({ pmRoot: lifecycleRoot, author: "acceptance" });
  await lifecycleClient.update("later-repair", { status: "custom_done", closeReason: "Duplicate", unset: ["parent", "goal", "objective", "sprint", "release"] });
  const lifecycleStore = new DirectoryReleaseMilestoneStore(lifecycleRoot);
  const omittedCapture = await createReleaseMilestone(lifecycleStore, "v1", await readTrackerReleaseSnapshot(lifecycleRoot));
  await lifecycleClient.update("later-repair", { status: "open", closeReason: "Investigating", unset: ["parent", "goal", "objective", "sprint", "release"] });
  await schemaAddStatus("custom_done", { role: ["active"] }, { pmRoot: lifecycleRoot });
  await lifecycleClient.update("later-repair", { status: "closed", title: "Packed later repaired claim", closeReason: "Fixed parser failure", unset: ["parent", "goal", "objective", "sprint", "release"] });
  const repairedSnapshot = await readTrackerReleaseSnapshot(lifecycleRoot);
  const repairCapture = await createReleaseMilestone(lifecycleStore, "v2", { ...repairedSnapshot, capturedAt: new Date(Math.max(Date.parse(repairedSnapshot.capturedAt), Date.parse(omittedCapture.capturedAt) + 1)).toISOString() });
  const selectedRoot = join(scratch, "selected/.agents/pm");
  await runInit("selected", { path: selectedRoot }, { defaults: true, agentGuidance: "skip" });
  await schemaAddStatus("shipped_elsewhere", { role: ["terminal", "terminal_done"] }, { pmRoot: selectedRoot });
  await runCreate({ id: "selected-repair", title: "Selected tracker repair", type: "Issue", status: "open", createMode: "progressive", unset: ["parent", "goal", "objective", "sprint", "release"] }, { path: selectedRoot, author: "acceptance" });
  await new PmClient({ pmRoot: selectedRoot, author: "acceptance" }).update("selected-repair", { status: "shipped_elsewhere", closeReason: "Fixed selected defect", unset: ["parent", "goal", "objective", "sprint", "release"] });
  const prefix = join(scratch, "npm-global");
  run("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", archive, `@unbrained/pm-cli@${pinned}`]);
  const extension = join(root, "extensions/pm-changelog");
  cpSync(join(prefix, "lib/node_modules/pm-changelog"), extension, { recursive: true });
  mkdirSync(join(extension, "node_modules"), { recursive: true });
  if (!existsSync(join(extension, "node_modules/@unbrained"))) symlinkSync(join(prefix, "lib/node_modules/@unbrained"), join(extension, "node_modules/@unbrained"), "junction");
  cpSync(extension, join(lifecycleRoot, "extensions/pm-changelog"), { recursive: true });
  const driftRoot = join(scratch, "drift/.agents/pm");
  await runInit("drift", { path: driftRoot }, { defaults: true, agentGuidance: "skip" });
  cpSync(extension, join(driftRoot, "extensions/pm-changelog"), { recursive: true });
  await runWithActiveExtensions({ path: driftRoot }, async () => {
    for (let version = 1; version <= 5; version++) {
      const obligations = version === 4 ? [{ id: "retry", removed: true, evidence: ["retired"] }]
        : [{ id: "retry", assumption: version === 1 ? "Read before writing" : "Read target revision before retry", commands: ["pm example apply"], evidence: [`release-${version}`] }];
      const facets = version === 3 ? Array.from({ length: 7 }, (_, facet) => ({ audience: "agent-behavior", text: "Declared behavior",
        obligations: Array.from({ length: Math.min(256, 1563 - facet * 256) }, (_, offset) => ({ ...obligations[0],
          evidence: Array.from({ length: 64 }, (_, evidence) => `e${((facet * 256 + offset) * 64 + evidence).toString(36)}`) })) }))
        : [{ audience: "agent-behavior", text: "Declared behavior", obligations }];
      await runCreate({ title: "Packed drift fixture", type: "Feature", status: "closed", closeReason: "Delivered", release: `${version}.0.0`, createMode: "progressive",
        field: [`change_facets=${JSON.stringify(facets)}`],
        unset: ["parent", "goal", "objective", "sprint", "assignee", "reviewer"] }, { path: driftRoot, author: "acceptance" });
    }
  });
  await runWithActiveExtensions({ path: driftRoot }, async () => {
    for (const release of ["6.0.0", "6.0.0 - 2026-10-29", "[v6.0.0] - 2026-10-29"]) {
      await runCreate({ title: "Foreign future metadata", type: "Feature", status: "closed", closeReason: "Delivered", release, createMode: "progressive",
        field: ["change_facets=[null]"], unset: ["parent", "goal", "objective", "sprint", "assignee", "reviewer"] }, { path: driftRoot, author: "acceptance" });
    }
  });
  const driftExpected = await readAgentContractDrift(driftRoot, { from: "1.0.0", to: "5.0.0" });
  assert.equal(driftExpected.complete, true);
  assert.equal(driftExpected.unchanged[0].evidence.length, 100032);
  const upgradeExpected = await readConsumerUpgrades(driftRoot, { audience: "agent-behavior", from: "1.0.0", to: "5.0.0" });
  assert.deepEqual(driftExpected.changes.map((row) => row.kind), ["changed", "removed", "added"]);
  assert.equal(driftExpected.unchanged.length, 1);
  const calendarRoot = join(scratch, "calendar/.agents/pm");
  await runInit("calendar", { path: calendarRoot }, { defaults: true, agentGuidance: "skip" });
  cpSync(extension, join(calendarRoot, "extensions/pm-changelog"), { recursive: true });
  await runWithActiveExtensions({ path: calendarRoot }, async () => {
    for (const release of ["v2026.06.07", "[v2026.06.09] - 2026-06-09"]) {
      const facets = release === "v2026.06.07" ? [{ audience: "agent-behavior", text: "Calendar contract", obligations: [{ id: "calendar", assumption: "Read revision", commands: ["pm example apply"], evidence: ["calendar"] }],
        breaking: true, upgrade_actions: [{ id: "calendar", title: "Read revision", requires: [] }] }] : [null];
      await runCreate({ title: "Calendar contract", type: "Feature", status: "closed", closeReason: "Delivered", release, createMode: "progressive",
        field: [`change_facets=${JSON.stringify(facets)}`], unset: ["parent", "goal", "objective", "sprint", "assignee", "reviewer"] }, { path: calendarRoot, author: "acceptance" });
    }
  });
  const calendarRange = { from: "2026.6.1", to: "2026.6.8" };
  const calendarDrift = await readAgentContractDrift(calendarRoot, calendarRange);
  const calendarUpgrades = await readConsumerUpgrades(calendarRoot, { ...calendarRange, audience: "agent-behavior" });
  assert.equal(calendarDrift.complete, true); assert.equal(calendarDrift.changes.length, 1); assert.equal(calendarDrift.changes[0].release, "2026.6.7");
  assert.equal(calendarUpgrades.action_count, 1);
  const unicodeRoot = join(scratch, "unicode/.agents/pm");
  await runInit("unicode", { path: unicodeRoot }, { defaults: true, agentGuidance: "skip" });
  cpSync(extension, join(unicodeRoot, "extensions/pm-changelog"), { recursive: true });
  const unicodeText = normalizeUnicodeText("native \ud800X\udfff \ud83d\ude00\r\n");
  await runWithActiveExtensions({ path: unicodeRoot }, async () => {
    const facets = [{ audience: "agent-behavior", text: unicodeText, breaking: true,
      obligations: [{ id: "unicode", assumption: unicodeText, commands: [unicodeText], evidence: [unicodeText] },
        { id: "sibling", assumption: "Valid sibling", commands: ["pm read"], evidence: ["sibling"] }],
      upgrade_actions: [{ id: "unicode", title: unicodeText, body: unicodeText, requires: [] }] }];
    await runCreate({ title: "Unicode fixture", type: "Feature", status: "closed", closeReason: "Delivered", release: "2.0.0", createMode: "progressive",
      field: [`change_facets=${JSON.stringify(facets)}`], unset: ["parent", "goal", "objective", "sprint", "assignee", "reviewer"] }, { path: unicodeRoot, author: "acceptance" });
  });
  const unicodeRange = { from: "1.0.0", to: "2.0.0" };
  const unicodeDrift = await readAgentContractDrift(unicodeRoot, unicodeRange);
  const unicodeAudience = await readAudienceContracts(unicodeRoot, { groupBy: "release" });
  const unicodeUpgrades = await readConsumerUpgrades(unicodeRoot, { ...unicodeRange, audience: "agent-behavior" });
  assert.equal(unicodeDrift.complete, true); assert.equal(unicodeDrift.changes.length, 2);
  const paths: string[] = [];
  let checks = 0;
  // Import the captured archive's SDK, rather than source or an unrelated installed version.
  const headingChecks = run(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { buildAudienceContracts, formatAudienceContracts, buildAgentContractDrift, formatAgentContractDrift, buildConsumerUpgrades, formatConsumerUpgrades } from ${JSON.stringify(join(extension, "dist/index.js"))};
    const current = { id: "current", title: "Current", status: "closed", release: "2.0.0", change_facets: [{ audience: "operator", text: "Current" }] };
    const future = { id: "future", title: "Future", status: "closed", release: "3.0.0", change_facets: null };
    const options = { groupBy: "release", untilVersion: "2.0.0", releaseWindows: [
      { heading: "3.0.0 - 2026-10-29", releaseTag: "v3.0.0" }, { heading: "2.0.0 - 2026-10-28", releaseTag: "v2.0.0" }] };
    const expected = buildAudienceContracts({ ...options, items: [current] });
    const actual = buildAudienceContracts({ ...options, items: [future, current] });
    assert.equal(actual.item_count, 1);
    for (const format of ["json", "toon"]) assert.equal(formatAudienceContracts(actual, format), formatAudienceContracts(expected, format));
    const facets = [{ audience: "agent-behavior", text: "Calendar", obligations: [{ id: "calendar", assumption: "Read revision", commands: ["pm example apply"], evidence: ["calendar"] }],
      breaking: true, upgrade_actions: [{ id: "calendar", title: "Read revision", requires: [] }] }];
    const calendar = { id: "calendar", title: "Calendar", status: "closed", release: "v2026.06.07", change_facets: facets };
    const later = { ...future, release: "v2026.06.09" };
    const range = { from: "2026.6.1", to: "2026.6.8" };
    const calendarOptions = { groupBy: "release", untilVersion: range.to, releaseWindows: [
      { heading: "v2026.06.09 - 2026-06-09", releaseTag: "v2026.6.9" }, { heading: "v2026.06.07 - 2026-06-07", releaseTag: "v2026.6.7" }] };
    const calendarAudience = buildAudienceContracts({ ...calendarOptions, items: [calendar, later] });
    assert.equal(calendarAudience.item_count, 1);
    const drift = buildAgentContractDrift({ ...range, items: [calendar, later] });
    assert.equal(drift.complete, true); assert.equal(drift.changes.length, 1); assert.equal(drift.changes[0].release, "2026.6.7");
    const upgrades = buildConsumerUpgrades({ ...range, audience: "agent-behavior", items: [calendar, later] });
    assert.equal(upgrades.action_count, 1);
    const model = { ...calendar, release: "2026.6.7" };
    for (const format of ["json", "toon"]) {
      assert.equal(formatAudienceContracts(calendarAudience, format), formatAudienceContracts(buildAudienceContracts({ ...calendarOptions, items: [calendar] }), format));
      assert.equal(formatAgentContractDrift(drift, format), formatAgentContractDrift(buildAgentContractDrift({ ...range, items: [model] }), format));
      assert.equal(formatConsumerUpgrades(upgrades, format), formatConsumerUpgrades(buildConsumerUpgrades({ ...range, audience: "agent-behavior", items: [model] }), format));
    }
    const illFormed = "text \\ud800X\\udfff 😀";
    const clean = Buffer.from(illFormed, "utf8").toString("utf8");
    assert.notEqual(illFormed, clean);
    const bad = { ...calendar, release: "2.0.0", change_facets: [{ audience: "agent-behavior", text: illFormed, breaking: true,
      obligations: [{ id: "unicode", assumption: illFormed, commands: [illFormed], evidence: [illFormed] }],
      upgrade_actions: [{ id: "unicode", title: illFormed, body: illFormed, requires: [] }] }] };
    const repaired = { ...bad, change_facets: [{ ...bad.change_facets[0], text: clean, obligations: [{ id: "unicode", assumption: clean, commands: [clean], evidence: [clean] }],
      upgrade_actions: [{ id: "unicode", title: clean, body: clean, requires: [] }] }] };
    for (const format of ["json", "toon"]) {
      assert.equal(formatAgentContractDrift(buildAgentContractDrift({ from: "1.0.0", to: "2.0.0", items: [bad] }), format), formatAgentContractDrift(buildAgentContractDrift({ from: "1.0.0", to: "2.0.0", items: [repaired] }), format));
      assert.equal(formatAudienceContracts(buildAudienceContracts({ items: [bad] }), format), formatAudienceContracts(buildAudienceContracts({ items: [repaired] }), format));
      assert.equal(formatConsumerUpgrades(buildConsumerUpgrades({ from: "1.0.0", to: "2.0.0", audience: "agent-behavior", items: [bad] }), format), formatConsumerUpgrades(buildConsumerUpgrades({ from: "1.0.0", to: "2.0.0", audience: "agent-behavior", items: [repaired] }), format));
    }
    console.log("14");
  `]);
  assert.equal(headingChecks.trim(), "14"); checks += 14;
  /** Check actual append, exact replay and both compact views against the SDK-read state. */
  async function accept(name: string, raw: (args: string[]) => string, host = false): Promise<void> {
    const launch = (args: string[]): string => raw(host ? ["--path", root, "changelog", "corrections", ...args] : ["corrections", "--pm-root", root, ...args]);
    const generate = (args: string[]): string => raw(host ? ["--path", root, "changelog", "generate", ...args] : ["--pm-root", root, ...args]);
    const view = await readReleaseCorrectionView(root, "v1", "accept-claim");
    assert.equal(view.original, "Published acceptance claim");
    const wrongFile = join(scratch, "later-snapshot.json");
    assert.equal(view.chain[0].id, "before-role-edit");
    for (const wrong of [draft, later]) {
      writeFileSync(wrongFile, JSON.stringify({ schema: 1, release: wrong.name, item: "accept-claim", milestone: wrong.fingerprint, id: `wrong-${name}`, supersedes: "", expectedRevision: wrong.fingerprint, wording: "Unpublished snapshot wording must refuse", evidence: ["docs/release-corrections.md"] }));
      for (const format of ["json", "toon"]) for (const action of [["view", "--release", wrong.name, "--item", "accept-claim"], ["append", "--input", wrongFile]]) {
        assert.throws(() => launch([...action, "--format", format]), (error: unknown) => {
          assert.ok(error && typeof error === "object" && "stderr" in error);
          assert.match(String(error.stderr), /correction_missing/); return true;
        }); checks++;
      }
    }
    const file = join(scratch, "correction.json");
    writeFileSync(file, JSON.stringify({ schema: 1, release: "v1", item: "accept-claim", milestone: view.milestone, id: name, supersedes: view.chain.at(-1)?.id ?? "", expectedRevision: view.revision,
      wording: `  Packed ${name} acceptance\r\n `, evidence: ["docs/release-corrections.md"] }));
    assert.equal(JSON.parse(launch(["append", "--input", file, "--json"])).changed, true); checks++;
    assert.equal(JSON.parse(launch(["append", "--input", file, "--json"])).changed, false); checks++;
    const expected = await readReleaseCorrectionView(root, "v1", "accept-claim");
    for (const flags of [["--json"], ["--format", "toon"]]) {
      const output = launch(["view", "--release", "v1", "--item", "accept-claim", ...flags]);
      assert.deepEqual(flags[0] === "--json" ? JSON.parse(output) : decode(output), expected); checks++;
      const oldOutput = launch(["view", "--release", "legacy-v2", "--item", "old-claim", ...flags]);
      assert.deepEqual(flags[0] === "--json" ? JSON.parse(oldOutput) : decode(oldOutput), await readReleaseCorrectionView(root, "legacy-v2", "old-claim")); checks++;
    }
    const wireDocument = JSON.parse(generate(["--milestones", "--changelog-json", "--suggest-semver", "--breaking-changes"])) as ChangelogDocument & { document?: ChangelogDocument };
    const document = host ? wireDocument.document! : wireDocument;
    assert.equal(document.excluded_non_change_count, 1); assert.equal(document.suggested_semver?.bump, "minor");
    assert.doesNotMatch(JSON.stringify(document), /Packed omitted duplicate/);
    const groups = document.releases.flatMap((release) => release.sections);
    assert.equal(groups.find((group) => group.items.some((item) => item.id === "accept-neutral"))!.heading, "Closed");
    assert.equal(groups.find((group) => group.items.some((item) => item.id === "accept-repair"))!.heading, "Fixed");
    assert.ok(!document.releases.some((release) => release.breaking_changes?.some((item) => item.id?.startsWith("accept-")))); checks++;
    const summary = JSON.parse(generate(["--milestones", "--summary", "--format", "json"])) as { entries: ChangelogSummaryEntry[]; excluded_non_change_count: number };
    assert.equal(summary.excluded_non_change_count, 1);
    assert.equal(summary.entries.find((entry) => entry.id === "accept-neutral")!.category, "Closed");
    assert.ok(!summary.entries.some((entry) => entry.id === "accept-duplicate")); checks++;
    const semver = JSON.parse(generate(["--milestones", "--suggest-semver", host ? "--explain-selection" : "--explain", "--json"])) as SemverSuggestion & { suggested_semver?: SemverSuggestion; excluded_non_change_count: number; selection_report: ChangelogSelectionReport };
    assert.equal((host ? semver.suggested_semver! : semver).bump, "minor"); assert.equal(semver.excluded_non_change_count, 1); assert.equal(semver.selection_report.excluded_counts.non_change, 1); checks++;
    const omitted = join(scratch, "omitted-claim.json");
    writeFileSync(omitted, JSON.stringify({ schema: 1, release: "v1", item: "accept-duplicate", milestone: published.fingerprint, id: "unpublished", supersedes: "", expectedRevision: published.fingerprint, wording: "No published claim", evidence: ["docs/release-corrections.md"] }));
    for (const format of ["json", "toon"]) for (const action of [["view", "--release", "v1", "--item", "accept-duplicate"], ["append", "--input", omitted]]) {
      assert.throws(() => launch([...action, "--format", format]), (error: unknown) => {
        assert.ok(error && typeof error === "object" && "stderr" in error); assert.match(String(error.stderr), /correction_missing/); return true;
      }); checks++;
    }
    assert.equal((await client.notes("accept-duplicate")).count, 0);
    const laterLaunch = (args: string[]): string => raw(host ? ["--path", lifecycleRoot, "changelog", "corrections", ...args] : ["corrections", "--pm-root", lifecycleRoot, ...args]);
    const laterGenerate = (args: string[]): string => raw(host ? ["--path", lifecycleRoot, "changelog", "generate", ...args] : ["--pm-root", lifecycleRoot, ...args]);
    const laterView = await readReleaseCorrectionView(lifecycleRoot, "v2", "later-repair");
    const lifecycleFile = join(scratch, "lifecycle-correction.json");
    writeFileSync(lifecycleFile, JSON.stringify({ schema: 1, release: "v1", item: "later-repair", milestone: omittedCapture.fingerprint, id: name, supersedes: "", expectedRevision: omittedCapture.fingerprint, wording: "Unpublished duplicate must refuse", evidence: ["docs/release-corrections.md"] }));
    for (const format of ["json", "toon"]) for (const action of [["view", "--release", "v1", "--item", "later-repair"], ["append", "--input", lifecycleFile]]) {
      assert.throws(() => laterLaunch([...action, "--format", format]), (error: unknown) => {
        assert.ok(error && typeof error === "object" && "stderr" in error); assert.match(String(error.stderr), /correction_missing/); return true;
      }); checks++;
    }
    writeFileSync(lifecycleFile, JSON.stringify({ schema: 1, release: "v2", item: "later-repair", milestone: repairCapture.fingerprint, id: name, supersedes: laterView.chain.at(-1)?.id ?? "", expectedRevision: laterView.revision, wording: `Reviewed later repair ${name}`, evidence: ["docs/release-corrections.md"] }));
    assert.equal(JSON.parse(laterLaunch(["append", "--input", lifecycleFile, "--json"])).changed, true); checks++;
    assert.equal(JSON.parse(laterLaunch(["append", "--input", lifecycleFile, "--json"])).changed, false); checks++;
    for (const format of ["json", "toon"]) {
      const output = laterLaunch(["view", "--release", "v2", "--item", "later-repair", "--format", format]);
      assert.deepEqual(format === "json" ? JSON.parse(output) : decode(output), await readReleaseCorrectionView(lifecycleRoot, "v2", "later-repair")); checks++;
    }
    const laterWire = JSON.parse(laterGenerate(["--milestones", "--changelog-json", "--suggest-semver"])) as ChangelogDocument & { document?: ChangelogDocument };
    const laterDocument = host ? laterWire.document! : laterWire;
    assert.equal(laterDocument.item_count, 1); assert.equal(laterDocument.excluded_non_change_count, 1);
    assert.equal(laterDocument.releases.flatMap((release) => release.sections.flatMap((section) => section.items)).filter((item) => item.id === "later-repair").length, 1); checks++;
    const laterSummary = JSON.parse(laterGenerate(["--milestones", "--summary", "--format", "json"])) as { entries: ChangelogSummaryEntry[] };
    assert.equal(laterSummary.entries.length, 1); assert.equal(laterSummary.entries[0].title, "Packed later repaired claim"); checks++;
    const laterSemver = JSON.parse(laterGenerate(["--milestones", "--suggest-semver", "--json"])) as SemverSuggestion & { suggested_semver?: SemverSuggestion };
    assert.equal((host ? laterSemver.suggested_semver! : laterSemver).bump, "patch"); checks++;
    assert.equal(createHash("sha512").update(readFileSync(archive)).digest("hex"), archiveSha512);
    if (!host) {
      const selected = (args: string[]): string => raw(["--pm-arg=--path", `--pm-arg=${selectedRoot}`, ...args]);
      assert.equal((JSON.parse(selected(["--changelog-json"])) as ChangelogDocument).item_count, 1); checks++;
      assert.equal((JSON.parse(selected(["--summary", "--format", "json"])) as { entries: ChangelogSummaryEntry[] }).entries[0].title, "Selected tracker repair"); checks++;
      assert.equal((JSON.parse(selected(["--suggest-semver", "--json"])) as SemverSuggestion).counts.fix, 1); checks++;
      for (const format of ["json", "toon"]) {
        const output = selected(["--audit-evidence", ...(format === "json" ? ["--json"] : [])]);
        const audit = (format === "json" ? JSON.parse(output) : decode(output)) as { claim_count: number };
        assert.equal(audit.claim_count, 1); checks++;
      }
    }
    const driftBefore = (await listAllComplete({ includeBody: true }, { pmRoot: driftRoot })).items;
    const drift = (args: string[]): string => raw(host ? ["--path", driftRoot, "changelog", "drift", ...args] : ["drift", "--pm-root", driftRoot, ...args]);
    for (const format of ["json", "toon"]) {
      const output = drift(["--from", "1.0.0", "--to", "5.0.0", "--format", format]);
      assert.deepEqual(format === "json" ? JSON.parse(output) : decode(output), driftExpected); checks++;
    }
    assert.throws(() => drift(["--from", "1.0.0", "--to", "5.0.0", "--format", "xml"]), (error: unknown) => {
      assert.ok(error && typeof error === "object" && "stderr" in error); assert.match(String(error.stderr), /invalid_drift_options/); return true;
    }); checks++;
    for (const format of ["json", "toon"]) {
      const output = raw(host ? ["--path", driftRoot, "changelog", "upgrades", "--audience", "agent-behavior", "--from", "1.0.0", "--to", "5.0.0", "--format", format]
        : ["upgrades", "--pm-root", driftRoot, "--audience", "agent-behavior", "--from", "1.0.0", "--to", "5.0.0", "--format", format]);
      assert.deepEqual(format === "json" ? JSON.parse(output) : decode(output), upgradeExpected); checks++;
    }
    assert.deepEqual((await listAllComplete({ includeBody: true }, { pmRoot: driftRoot })).items, driftBefore); checks++;
    const calendarBefore = (await listAllComplete({ includeBody: true }, { pmRoot: calendarRoot })).items;
    for (const format of ["json", "toon"]) for (const command of ["drift", "upgrades"]) {
      const args = ["--from", calendarRange.from, "--to", calendarRange.to, "--format", format, ...(command === "upgrades" ? ["--audience", "agent-behavior"] : [])];
      const output = raw(host ? ["--path", calendarRoot, "changelog", command, ...args] : [command, "--pm-root", calendarRoot, ...args]);
      assert.deepEqual(format === "json" ? JSON.parse(output) : decode(output), command === "drift" ? calendarDrift : calendarUpgrades); checks++;
    }
    assert.deepEqual((await listAllComplete({ includeBody: true }, { pmRoot: calendarRoot })).items, calendarBefore); checks++;
    const unicodeBefore = (await listAllComplete({ includeBody: true }, { pmRoot: unicodeRoot })).items;
    for (const format of ["json", "toon"]) for (const command of ["drift", "contracts", "upgrades"]) {
      const args = command === "contracts" ? ["--group-by", "release"] : ["--from", unicodeRange.from, "--to", unicodeRange.to, ...(command === "upgrades" ? ["--audience", "agent-behavior"] : [])];
      const output = raw(host ? ["--path", unicodeRoot, "changelog", command, ...args, "--format", format] : [command, "--pm-root", unicodeRoot, ...args, "--format", format]);
      assert.deepEqual(format === "json" ? JSON.parse(output) : decode(output), command === "drift" ? unicodeDrift : command === "contracts" ? unicodeAudience : unicodeUpgrades); checks++;
    }
    assert.deepEqual((await listAllComplete({ includeBody: true }, { pmRoot: unicodeRoot })).items, unicodeBefore); checks++;
    paths.push(name);
  }
  await accept("npm-global", (args) => run(join(prefix, "bin/pm-changelog"), args));
  await accept("npm-global-host", (args) => run(join(prefix, "bin/pm"), args), true);
  run("bun", ["add", "--global", "--ignore-scripts", archive, `@unbrained/pm-cli@${pinned}`]);
  await accept("bun-global", (args) => run(join(childEnv.BUN_INSTALL, "bin/pm-changelog"), args));
  await accept("bun-global-host", (args) => run(join(childEnv.BUN_INSTALL, "bin/pm"), args), true);
  for (const manager of ["npm", "bun"]) {
    const cwd = join(scratch, `${manager}-local`); mkdirSync(cwd); writeFileSync(join(cwd, "package.json"), JSON.stringify({ private: true, type: "module" }));
    run(manager, [manager === "npm" ? "install" : "add", "--ignore-scripts", archive, `@unbrained/pm-cli@${pinned}`], cwd);
    await accept(`${manager}-local`, (args) => run(join(cwd, "node_modules/.bin/pm-changelog"), args, cwd));
  }
  await accept("npx", (args) => run("npx", ["--yes", "--package", archive, "--package", `@unbrained/pm-cli@${pinned}`, "pm-changelog", ...args]));
  await accept("bunx", (args) => run("bun", ["x", "--bun", "--package", archive, "pm-changelog", ...args]));
  assert.equal(checks, 444); assert.equal(paths.length, 8);
  assert.equal((await readReleaseCorrectionView(root, "v1", "accept-claim")).chain.length, 9);
  assert.equal((await readReleaseCorrectionView(root, "legacy-v2", "old-claim")).chain.length, 1);
  assert.equal((await readReleaseCorrectionView(lifecycleRoot, "v2", "later-repair")).chain.length, 8);
  console.log(JSON.stringify({ installation_modes: 6, drift_checks: 32, release_scope_checks: 16, heading_forms: 3, heading_sdk_checks: 8, unicode_sdk_checks: 6, unicode_launcher_checks: 56, calendar_launcher_checks: 40, aggregate_evidence_ids: 100032, launcher_paths: paths, checks, archive_sha512: archiveSha512, lifecycle_checks: 88, later_corrections: (await readReleaseCorrectionView(lifecycleRoot, "v2", "later-repair")).chain.length, wrong_release_checks: 96, corrections: (await readReleaseCorrectionView(root, "v1", "accept-claim")).chain.length, legacy_corrections: (await readReleaseCorrectionView(root, "legacy-v2", "old-claim")).chain.length, registry_drift: true, closure_role_checks: 56, non_git: true }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
