import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { decode, encode } from "@toon-format/toon";
import { PmClient, readSettings, resolveRuntimeStatusRegistry, runCreate, runInit, schemaAddStatus } from "@unbrained/pm-cli/sdk";
import type { RuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import extension from "../src/extension.ts";
import { appendReleaseCorrection, createChangelog, createReleaseMilestone, DirectoryReleaseMilestoneStore, explainChangelogSelection, formatReleaseCorrectionView, parseReleaseMilestone, readReleaseCorrectionView, readReleaseMilestones, readTrackerReleaseSnapshot, resolveTrackerReleaseHistory, resolveTrackerReleaseLedger } from "../src/index.ts";
import type { ReleaseMilestone, TrackerReleaseSnapshot } from "../src/index.ts";

/** Real tracker with a draft capture followed by publication under a custom done role. */
async function publication(t: { after(fn: () => void): void }, seedCorrection = true) {
  const cwd = mkdtempSync(join(tmpdir(), "pm-frozen-roles-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, ".agents/pm");
  await runInit("freeze", { path: root }, { defaults: true, agentGuidance: "skip" });
  await schemaAddStatus("mutable_draft", { role: ["active"] }, { pmRoot: root });
  await schemaAddStatus("mutable_done", { role: ["terminal", "terminal_done"] }, { pmRoot: root });
  await runCreate({ id: "freeze-claim", title: "Unpublished draft", type: "Feature", status: "mutable_draft", createMode: "progressive", unset: ["parent", "goal", "objective", "sprint", "release"] }, { path: root, author: "fixture" });
  const client = new PmClient({ pmRoot: root, author: "fixture" });
  const store = new DirectoryReleaseMilestoneStore(root);
  const draft = await createReleaseMilestone(store, "v1", { ...(await readTrackerReleaseSnapshot(root)), capturedAt: "2026-10-01T00:00:00Z" });
  await client.update("freeze-claim", { status: "mutable_done", title: "Published v2 wording", closeReason: "Delivered", unset: ["parent", "goal", "objective", "sprint", "release"] });
  const released = await createReleaseMilestone(store, "v2", { ...(await readTrackerReleaseSnapshot(root)), capturedAt: "2026-10-02T00:00:00Z" });
  const request = { schema: 1, release: released.name, item: "freeze-claim", milestone: released.fingerprint, id: "accuracy", supersedes: "", expectedRevision: released.fingerprint, wording: "Reviewed v2 correction\r\n ", evidence: ["docs/release-corrections.md"] };
  if (seedCorrection) await appendReleaseCorrection(root, request);
  return { cwd, root, client, store, draft, released, request };
}

/** Redefine both historical status tokens using the actual SDK schema writer. */
async function roles(root: string, promoteDraft: boolean): Promise<void> {
  await schemaAddStatus("mutable_draft", { role: promoteDraft ? ["terminal", "terminal_done"] : ["active"], alias: [promoteDraft ? "draft_now_done" : "draft_now_active"] }, { pmRoot: root });
  await schemaAddStatus("mutable_done", { role: promoteDraft ? ["blocked"] : ["terminal", "terminal_done"], alias: [promoteDraft ? "done_now_blocked" : "done_now_done"] }, { pmRoot: root });
  const registry = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
  assert.equal(registry.terminal_done_statuses.has("mutable_draft"), promoteDraft);
  assert.equal(registry.terminal_done_statuses.has("mutable_done"), !promoteDraft);
}

test("capture-time publication survives promotion and demotion of historical status roles", async (t) => {
  const { root, store, draft, released } = await publication(t, false);
  assert.equal(released.schema, 2); assert.deepEqual(draft.doneItemIds, []); assert.deepEqual(released.doneItemIds, ["freeze-claim"]);
  await roles(root, true);
  const registry = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
  assert.equal(resolveTrackerReleaseLedger(await readReleaseMilestones(store), registry).claims.get("freeze-claim")?.milestone.name, "v2");
  const history = resolveTrackerReleaseHistory(await readReleaseMilestones(store), [], registry);
  assert.match(createChangelog(history).markdown, /Published v2 wording/);
  assert.doesNotMatch(createChangelog(history).markdown, /Unpublished draft/);
  assert.equal(explainChangelogSelection(history).excluded_counts.status, 0);
});

test("500 registry and round-trip sequences cannot reinterpret captured publication or hide corrections", async (t) => {
  const { root, client, store, draft, released, request } = await publication(t);
  const native = (await client.get("freeze-claim", { full: true })).item;
  const original = await readReleaseCorrectionView(root, "v2", "freeze-claim");
  const before = createChangelog(resolveTrackerReleaseHistory(await readReleaseMilestones(store), [])).markdown;
  const pool: RuntimeStatusRegistry[] = [];
  for (let index = 0; index < 4; index++) {
    await roles(root, index % 2 === 0);
    pool.push(resolveRuntimeStatusRegistry((await readSettings(root)).schema));
    assert.deepEqual((await client.get("freeze-claim", { full: true })).item, native);
    assert.deepEqual(await readReleaseCorrectionView(root, "v2", "freeze-claim"), original);
    assert.equal((await appendReleaseCorrection(root, request)).changed, false);
    await assert.rejects(readReleaseCorrectionView(root, "v1", "freeze-claim"), { code: "correction_missing" });
  }
  let seed = 0x291f2;
  for (let sequence = 0; sequence < 500; sequence++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const registry = pool[seed % pool.length];
    const captures = seed & 16 ? [draft, released] : [released, draft];
    const roundTrip = captures.map((capture) => parseReleaseMilestone(seed & 32 ? JSON.parse(JSON.stringify(capture)) : decode(encode(capture))));
    const older = roundTrip[seed & 1];
    assert.deepEqual(await createReleaseMilestone(store, older.name, older), older);
    if (sequence % 64 === 0) {
      assert.deepEqual((await client.get("freeze-claim", { full: true })).item, native);
      assert.deepEqual(await readReleaseCorrectionView(root, "v2", "freeze-claim"), original);
    }
    assert.equal(resolveTrackerReleaseLedger(roundTrip, registry).claims.get("freeze-claim")!.milestone.name, "v2");
    const history = resolveTrackerReleaseHistory(roundTrip, [], registry);
    assert.equal(createChangelog(history).markdown, before);
    assert.equal(explainChangelogSelection(history).excluded_counts.status, 0);
    for (const format of ["json", "toon"] as const) {
      const text = formatReleaseCorrectionView(original, format);
      assert.deepEqual(format === "json" ? JSON.parse(text) : decode(text), original);
    }
  }
  await roles(root, true);
  const future = await createReleaseMilestone(store, "v3", { ...(await readTrackerReleaseSnapshot(root)), capturedAt: "2026-10-03T00:00:00Z" });
  assert.deepEqual(future.doneItemIds, []);
  assert.equal(resolveTrackerReleaseLedger(await readReleaseMilestones(store)).claims.get("freeze-claim")!.milestone.name, "v2");
  assert.deepEqual(await readReleaseCorrectionView(root, "v2", "freeze-claim"), original);
  t.diagnostic("seed=0x291f2 sequences=500; SDK role/alias changes, older-input round trips, frozen history and SDK-read correction state");
});

test("publication eligibility is validated and fingerprint-bound; released schema-1 fixtures stay unchanged", async (t) => {
  const { root, store, released } = await publication(t);
  const legacy = JSON.parse(readFileSync(resolve("test/fixtures/milestones-v1-publication.json"), "utf8")) as ReleaseMilestone[];
  await roles(root, true);
  const registry = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
  const legacyBytes = JSON.stringify(legacy);
  for (const captures of [legacy, legacy.map((capture) => parseReleaseMilestone(decode(encode(capture))))]) {
    assert.equal(resolveTrackerReleaseLedger(captures, registry).claims.get("old-claim")!.milestone.name, "legacy-v2");
    assert.equal(resolveTrackerReleaseLedger(captures, registry).claims.get("old-padded")!.milestone.name, "legacy-v2");
    assert.equal(resolveTrackerReleaseLedger(captures, registry).claims.get("old-uppercase")!.milestone.name, "legacy-v1");
    assert.match(createChangelog(resolveTrackerReleaseHistory(captures, [], registry)).markdown, /Legacy released wording/);
    assert.doesNotMatch(createChangelog(resolveTrackerReleaseHistory(captures, [], registry)).markdown, /Legacy draft/);
  }
  assert.equal(JSON.stringify(legacy), legacyBytes);
  await runCreate({ id: "old-claim", title: "Legacy released wording", type: "Feature", status: "closed", closeReason: "Delivered", createMode: "progressive", unset: ["parent", "goal", "objective", "sprint", "release"] }, { path: root, author: "fixture" });
  const legacyStore = new DirectoryReleaseMilestoneStore(join(root, "legacy-storage"));
  for (const capture of legacy) await legacyStore.publish(capture.name, capture);
  const legacyView = await readReleaseCorrectionView(root, "legacy-v2", "old-claim", { milestones: legacyStore });
  const legacyCorrection = { schema: 1, release: "legacy-v2", item: "old-claim", milestone: legacyView.milestone, expectedRevision: legacyView.revision, id: "legacy-accuracy", supersedes: "", wording: "Legacy correction", evidence: ["docs/release-corrections.md"] };
  assert.equal((await appendReleaseCorrection(root, legacyCorrection, { milestones: legacyStore })).changed, true);
  assert.equal((await appendReleaseCorrection(root, legacyCorrection, { milestones: legacyStore })).changed, false);
  assert.equal((await readReleaseCorrectionView(root, "legacy-v2", "old-claim", { milestones: legacyStore })).chain.length, 1);
  for (const capture of legacy) assert.deepEqual(await legacyStore.read(capture.name), capture);
  const sparse = new Array(2); sparse[1] = "freeze-claim";
  const extra = ["freeze-claim"]; Object.assign(extra, { hidden: true });
  const disguised = new Array(2); disguised[1] = "freeze-claim"; Object.assign(disguised, { extra: "freeze-claim" });
  const bad: unknown[] = [undefined, null, NaN, Infinity, -Infinity, 1, {}, sparse, extra, disguised, [null], ["foreign"], ["freeze-claim", "freeze-claim"], Array(100001).fill("freeze-claim"), new Array(0xffffffff)];
  for (const doneItemIds of bad) {
    assert.throws(() => parseReleaseMilestone({ ...released, doneItemIds }), { code: "milestone_invalid" });
    if (doneItemIds !== undefined) await assert.rejects(createReleaseMilestone(store, "bad", { capturedAt: "2026-10-04T00:00:00Z", items: released.items, doneItemIds } as TrackerReleaseSnapshot), { code: "milestone_invalid" });
  }
  assert.throws(() => parseReleaseMilestone({ ...released, doneItemIds: [] }), { code: "milestone_invalid" });
  assert.throws(() => parseReleaseMilestone({ ...released, unexpected: true }), { code: "milestone_invalid" });
  assert.throws(() => parseReleaseMilestone({ ...released, items: released.items.map((item) => ({ ...item, toJSON: () => ({ ...item, id: "transformed" }) })) }), { code: "milestone_invalid" });
  assert.throws(() => parseReleaseMilestone({ toJSON: () => released }), { code: "milestone_invalid" });
  assert.equal(await store.read("bad"), undefined);
  const filtered = await createReleaseMilestone(store, "filtered", { capturedAt: "2026-10-04T00:00:00Z", items: released.items, doneItemIds: ["freeze-claim"] }, "id:absent");
  assert.deepEqual(filtered.doneItemIds, []);
  assert.deepEqual(parseReleaseMilestone(JSON.parse(JSON.stringify(filtered))), filtered);
  assert.equal((await readReleaseCorrectionView(root, "v2", "freeze-claim")).chain.length, 1);
});

test("live selection uses current roles while frozen selection and explicit filters agree with diagnostics", async (t) => {
  const { root, client, store } = await publication(t);
  await roles(root, true);
  await runCreate({ id: "freeze-live", title: "Live blocked work", type: "Feature", status: "mutable_done", createMode: "progressive", unset: ["parent", "goal", "objective", "sprint", "release"] }, { path: root, author: "fixture" });
  const registry = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
  const history = resolveTrackerReleaseHistory(await readReleaseMilestones(store), (await readTrackerReleaseSnapshot(root)).items, registry);
  const output = createChangelog(history);
  assert.match(output.markdown, /Published v2 wording/); assert.doesNotMatch(output.markdown, /Live blocked work|Unpublished draft/);
  assert.equal(explainChangelogSelection(history).excluded_counts.status, 1);
  assert.equal(explainChangelogSelection(history).filters.status_selection, "per-item");
  const explicit = { ...history, includeStatuses: ["mutable_done"] };
  assert.match(createChangelog(explicit).markdown, /Live blocked work/);
  assert.equal(explainChangelogSelection(explicit).excluded_counts.status, 0);
  assert.equal(explainChangelogSelection(explicit).filters.status_selection, undefined);
  assert.match(createChangelog({ ...history, includeStatuses: [] }).markdown, /Live blocked work/);
  assert.equal(explainChangelogSelection({ ...history, includeStatuses: [] }).excluded_counts.status, 0);
  assert.equal((await client.notes("freeze-claim")).count, 1);
});

test("standalone and host JSON/TOON views and generation survive registry edits without git", async (t) => {
  const { cwd, root, client, request } = await publication(t);
  const before = await readReleaseCorrectionView(root, "v2", "freeze-claim");
  const extensionRoot = join(root, "extensions/pm-changelog"); mkdirSync(extensionRoot, { recursive: true });
  cpSync(resolve("dist"), join(extensionRoot, "dist"), { recursive: true });
  cpSync(resolve("manifest.json"), join(extensionRoot, "manifest.json"));
  writeFileSync(join(extensionRoot, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(resolve("node_modules"), join(extensionRoot, "node_modules"), "junction");
  await roles(root, true);
  const noGit = join(cwd, "bin"); mkdirSync(noGit);
  const env = { ...process.env, PATH: noGit, PM_PATH: root, PM_AUTHOR: "fixture", PM_GLOBAL_PATH: join(cwd, "global"), GIT_CEILING_DIRECTORIES: dirname(cwd), DO_NOT_TRACK: "1" };
  const file = join(cwd, "correction.json"); writeFileSync(file, JSON.stringify(request));
  const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] });
  assert.deepEqual(activation.failed, []);
  for (const format of ["json", "toon"] as const) {
    for (const command of [[resolve("dist/cli.js"), "corrections", "--pm-root", root], [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", root, "changelog", "corrections"]]) {
      const view = spawnSync(process.execPath, [...command, "view", "--release", "v2", "--item", "freeze-claim", "--format", format], { cwd, env, encoding: "utf8" });
      assert.equal(view.status, 0, view.stderr);
      assert.deepEqual(format === "json" ? JSON.parse(view.stdout) : decode(view.stdout), before);
      const replay = spawnSync(process.execPath, [...command, "append", "--input", file, "--format", format], { cwd, env, encoding: "utf8" });
      assert.equal(replay.status, 0, replay.stderr);
      assert.equal((format === "json" ? JSON.parse(replay.stdout) : decode(replay.stdout) as { changed: boolean }).changed, false);
    }
    const host = await runRegisteredCommandForTest(activation.commands, { command: "changelog corrections", pmRoot: root, args: ["view"], options: { release: "v2", item: "freeze-claim", format } });
    assert.ok(host.result && typeof host.result === "object" && "output" in host.result && typeof host.result.output === "string");
    assert.deepEqual(format === "json" ? JSON.parse(host.result.output) : decode(host.result.output), before);
  }
  const output = spawnSync(process.execPath, [resolve("dist/cli.js"), "--milestones", "--pm-root", root, "--stdout"], { cwd, env, encoding: "utf8" });
  assert.equal(output.status, 0, output.stderr); assert.match(output.stdout, /Published v2 wording/); assert.doesNotMatch(output.stdout, /Unpublished draft/);
  const host = await runRegisteredCommandForTest(activation.commands, { command: "changelog generate", pmRoot: root, options: { milestones: true, stdout: true } });
  assert.ok(host.result && typeof host.result === "object" && "changelog" in host.result); assert.equal(host.result.changelog, output.stdout);
  assert.equal((await client.notes("freeze-claim")).count, 1);
});
