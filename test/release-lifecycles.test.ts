import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { decode, encode } from "@toon-format/toon";
import { PmClient, normalizeStatusInput, readSettings, resolveRuntimeStatusRegistry, runCreate, runInit, schemaAddStatus } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import extension from "../src/extension.ts";
import { appendReleaseCorrection, buildChangelogDocument, createChangelog, createChangelogSummary, createReleaseMilestone, DirectoryReleaseMilestoneStore, explainChangelogSelection, formatReleaseCorrectionView, parseReleaseMilestone, readReleaseCorrectionView, readReleaseMilestones, readTrackerReleaseSnapshot, resolveTrackerReleaseHistory, resolveTrackerReleaseLedger, suggestSemver } from "../src/index.ts";
import type { PmItem, ReleaseCorrectionInput, ReleaseMilestone } from "../src/index.ts";

const unset = ["parent", "goal", "objective", "sprint", "release"];
const dispositions = ["Duplicate", "Won’t fix", "Not planned", "Invalid", "Superseded", "Cannot reproduce", "Wontfix", "Won't fix"];

/** Native tracker, explicit scope and monotone boundaries; no SDK substitution is used. */
async function tracker(t: { after(fn: () => void): void }) {
  const cwd = mkdtempSync(join(tmpdir(), "pm-release-lifecycle-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, ".agents/pm");
  await runInit("life", { path: root }, { defaults: true, agentGuidance: "skip" });
  const client = new PmClient({ pmRoot: root, author: "lifecycle" });
  const store = new DirectoryReleaseMilestoneStore(root);
  let previous = 0;
  const capture = async (name: string, query = "*"): Promise<ReleaseMilestone> => {
    const snapshot = await readTrackerReleaseSnapshot(root);
    previous = Math.max(previous + 1, Date.parse(snapshot.capturedAt));
    return createReleaseMilestone(store, name, { ...snapshot, capturedAt: new Date(previous).toISOString() }, query);
  };
  return { cwd, root, client, store, capture };
}

/** One correction identity belongs to one exact owning target revision. */
function request(capture: ReleaseMilestone, item: string): ReleaseCorrectionInput {
  return { schema: 1, release: capture.name, item, milestone: capture.fingerprint, id: "first", supersedes: "", expectedRevision: capture.fingerprint,
    wording: `  Reviewed ${item}\r\n `, evidence: ["docs/release-corrections.md"] };
}

/** Read native state after every update, retaining the SDK's own normalization. */
async function update(client: PmClient, id: string, values: { title: string; status: string; closeReason: string; tags?: string }): Promise<PmItem> {
  await client.update(id, { ...values, unset });
  const item = (await client.get(id, { full: true })).item;
  assert.ok(typeof item.title === "string");
  return { ...item, title: item.title };
}

test("omitted and filtered captures own nothing; SDK/host/standalone expose the later repair without git", async (t) => {
  const { cwd, root, client, store, capture } = await tracker(t);
  await schemaAddStatus("custom_done", { role: ["terminal", "terminal_done"] }, { pmRoot: root });
  await schemaAddStatus("custom_draft", { role: ["active"] }, { pmRoot: root });
  for (const id of ["life-duplicate", "life-draft", "life-filtered"]) {
    await runCreate({ id, title: `Original ${id}`, type: "Issue", status: "open", createMode: "progressive", unset }, { path: root, author: "lifecycle" });
    await update(client, id, { title: `Original ${id}`, status: id === "life-draft" ? "custom_draft" : "custom_done", closeReason: id === "life-duplicate" ? "Duplicate" : "Investigation complete", tags: id === "life-filtered" ? "hidden" : "shipping" });
  }
  const first = await capture("v1", "tag:shipping");
  assert.equal(resolveTrackerReleaseLedger([first]).claims.size, 0);
  assert.equal(resolveTrackerReleaseHistory([first], []).releaseMembership.size, 0);
  await schemaAddStatus("custom_done", { role: ["active"] }, { pmRoot: root });
  await schemaAddStatus("custom_draft", { role: ["terminal", "terminal_done"] }, { pmRoot: root });
  for (const id of ["life-duplicate", "life-draft", "life-filtered"]) {
    await update(client, id, { title: `Reopened ${id}`, status: "open", closeReason: "Investigating" });
    await update(client, id, { title: `Repair ${id}`, status: "closed", closeReason: "Fixed parser failure", tags: "shipping" });
  }
  const repaired = await capture("v2");
  const registry = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
  const before = createChangelog(resolveTrackerReleaseHistory([first, repaired], [], registry)).markdown;
  for (const id of ["life-duplicate", "life-draft", "life-filtered"]) {
    assert.equal(resolveTrackerReleaseLedger([first, repaired], registry).claims.get(id)!.milestone.name, "v2");
    await assert.rejects(readReleaseCorrectionView(root, "v1", id), { code: "correction_missing" });
    const uncorrected = await readReleaseCorrectionView(root, "v2", id);
    assert.equal(uncorrected.original, `Repair ${id}`); assert.deepEqual(uncorrected.chain, []);
    assert.equal((await appendReleaseCorrection(root, request(repaired, id))).changed, true);
    assert.equal((await appendReleaseCorrection(root, request(repaired, id))).changed, false);
    await update(client, id, { title: `Later edit ${id}`, status: "open", closeReason: "Investigating again" });
  }
  await capture("v3");
  const history = resolveTrackerReleaseHistory(await readReleaseMilestones(store), [], registry);
  assert.equal(createChangelog(history).markdown, before);
  assert.equal(buildChangelogDocument(history).item_count, 3);
  assert.equal(buildChangelogDocument(history).excluded_non_change_count, 1);
  assert.equal(new Set(history.items.map((item) => item.id)).size, history.items.length);
  const extensionRoot = join(root, "extensions/pm-changelog"); mkdirSync(extensionRoot, { recursive: true });
  cpSync(resolve("dist"), join(extensionRoot, "dist"), { recursive: true }); cpSync(resolve("manifest.json"), join(extensionRoot, "manifest.json"));
  writeFileSync(join(extensionRoot, "package.json"), JSON.stringify({ type: "module" })); symlinkSync(resolve("node_modules"), join(extensionRoot, "node_modules"), "junction");
  const bin = join(cwd, "bin"); mkdirSync(bin);
  const childEnv = { ...process.env, PATH: bin, PM_PATH: root, PM_AUTHOR: "lifecycle", PM_GLOBAL_PATH: join(cwd, "global"), GIT_CEILING_DIRECTORIES: dirname(cwd), DO_NOT_TRACK: "1" };
  const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] }); assert.deepEqual(activation.failed, []);
  for (const format of ["json", "toon"] as const) {
    for (const command of [[resolve("dist/cli.js"), "corrections", "--pm-root", root], [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", root, "changelog", "corrections"]]) {
      const viewed = spawnSync(process.execPath, [...command, "view", "--release", "v2", "--item", "life-duplicate", "--format", format], { cwd, env: childEnv, encoding: "utf8" });
      assert.equal(viewed.status, 0, viewed.stderr);
      const result = format === "json" ? JSON.parse(viewed.stdout) : decode(viewed.stdout);
      assert.deepEqual(result, await readReleaseCorrectionView(root, "v2", "life-duplicate"));
    }
    const hosted = await runRegisteredCommandForTest(activation.commands, { command: "changelog corrections", pmRoot: root, args: ["view"], options: { release: "v2", item: "life-duplicate", format } });
    assert.ok(hosted.result && typeof hosted.result === "object" && "output" in hosted.result && typeof hosted.result.output === "string");
    assert.deepEqual(format === "json" ? JSON.parse(hosted.result.output) : decode(hosted.result.output), await readReleaseCorrectionView(root, "v2", "life-duplicate"));
  }
  const generated = spawnSync(process.execPath, [resolve("dist/cli.js"), "--pm-root", root, "--milestones", "--changelog-json"], { cwd, env: childEnv, encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr); assert.equal(JSON.parse(generated.stdout).item_count, 3);
  const hosted = await runRegisteredCommandForTest(activation.commands, { command: "changelog generate", pmRoot: root, options: { milestones: true, stdout: true } });
  assert.ok(hosted.result && typeof hosted.result === "object" && "changelog" in hosted.result); assert.equal(hosted.result.changelog, before);
});

/** Independent operation model; disposition semantics come from chosen actions, never production predicates. */
interface Lifecycle {
  id: string; length: number; repairAt: number; prelude: number; disposition: string; seed: number;
  owner?: { capture: ReleaseMilestone; title: string }; native?: PmItem; correction?: ReleaseCorrectionInput;
}

test("500 seeded native lifecycles across 2-4 releases preserve published bytes, unique repairs and correction accessibility", async (t) => {
  const { root, client, store, capture } = await tracker(t);
  let seed = 0x291f4;
  const random = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8;
  const models: Lifecycle[] = [];
  for (let index = 0; index < 500; index++) {
    const length = 2 + random() % 3;
    const model: Lifecycle = { id: `life-${index}`, length, repairAt: 1 + random() % (length - 1), prelude: random() % 3, disposition: dispositions[index % dispositions.length], seed: random() };
    models.push(model);
    await runCreate({ id: model.id, title: `Draft ${model.id}`, type: "Issue", status: "open", createMode: "progressive", unset }, { path: root, author: "lifecycle" });
  }
  const captures: ReleaseMilestone[] = [];
  const publishedBytes = new Map<string, string>();
  const releaseCounts = new Set<number>();
  const seenDispositions = new Set<string>();
  for (let phase = 0; phase < 4; phase++) {
    for (let earlier = 0; earlier < phase; earlier++) {
      await schemaAddStatus(`done_${earlier}`, { role: ["active"] }, { pmRoot: root });
      await schemaAddStatus(`draft_${earlier}`, { role: ["terminal", "terminal_done"] }, { pmRoot: root });
      await schemaAddStatus(`canceled_${earlier}`, { role: ["terminal", "terminal_done"] }, { pmRoot: root });
    }
    const done = `done_${phase}`, draft = `draft_${phase}`, canceled = `canceled_${phase}`;
    await schemaAddStatus(done, { role: ["terminal", "terminal_done"], alias: [`landed_${phase}`] }, { pmRoot: root });
    await schemaAddStatus(draft, { role: ["active"] }, { pmRoot: root });
    await schemaAddStatus(canceled, { role: ["terminal", "terminal_canceled"] }, { pmRoot: root });
    const registry = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
    for (const model of models) {
      releaseCounts.add(model.length);
      if (phase >= model.length) continue;
      const repaired = phase >= model.repairAt;
      const reopen = { title: `Reopened ${model.id} phase ${phase}`, status: "open", closeReason: "Investigation in progress" };
      await update(client, model.id, reopen);
      const filteredRepair = phase === 0 && model.prelude === 2;
      const status = filteredRepair ? "closed" : repaired ? (model.seed & 1 ? done : "closed") : model.prelude === 1 ? draft : model.seed & 2 ? canceled : done;
      const reason = filteredRepair ? "Fixed staged parser failure" : repaired ? "Fixed reproducible parser failure" : model.prelude === 1 ? "Investigation in progress" : model.disposition;
      if (!repaired && model.prelude !== 1) seenDispositions.add(model.disposition);
      model.native = await update(client, model.id, { title: `${repaired ? "Repair" : "Omitted"} ${model.id} phase ${phase}`, status, closeReason: reason, tags: phase === 0 && model.prelude === 2 ? "hidden" : "shipping" });
      assert.equal(normalizeStatusInput(model.native.status, registry), normalizeStatusInput(status, registry));
      assert.equal(model.native.close_reason, reason);
      assert.equal(registry.terminal_done_statuses.has(normalizeStatusInput(model.native.status, registry)!), filteredRepair || repaired || (!repaired && model.prelude !== 1 && !(model.seed & 2)));
    }
    const released = await capture(`v${phase + 1}`, phase === 0 ? "tag:shipping" : "*"); captures.push(released);
    for (const model of models) if (!model.owner && phase < model.length && phase >= model.repairAt) model.owner = { capture: released, title: model.native!.title };
    // JSON/TOON producer round trips, reordered catalogs and old-input replay preserve the same model.
    const stored = await readReleaseMilestones(store); assert.deepEqual(stored, captures);
    const shuffled = [...stored].reverse().map((item) => parseReleaseMilestone(random() & 1 ? JSON.parse(JSON.stringify(item)) : decode(encode(item))));
    const oldest = captures[random() % captures.length]; assert.deepEqual(await createReleaseMilestone(store, oldest.name, oldest), oldest);
    const ledger = resolveTrackerReleaseLedger(shuffled, registry);
    const history = resolveTrackerReleaseHistory(shuffled, [], registry);
    assert.equal(new Set(history.items.map((item) => item.id)).size, history.items.length);
    const document = buildChangelogDocument({ ...history, suggestSemver: true });
    const summary = createChangelogSummary(history);
    const expected = models.filter((model) => model.owner);
    assert.equal(ledger.claims.size, expected.length);
    assert.equal(document.item_count, expected.length); assert.equal(summary.length, expected.length);
    assert.equal(suggestSemver(history).counts.fix, expected.length);
    assert.equal(explainChangelogSelection(history).stage_counts.visible_items, expected.length);
    const markdown = createChangelog(history).markdown;
    for (const block of markdown.split(/(?=^## )/m).slice(1)) {
      const heading = block.slice(0, block.indexOf("\n"));
      if (publishedBytes.has(heading)) assert.equal(block, publishedBytes.get(heading));
      else publishedBytes.set(heading, block);
    }
    for (const [heading, bytes] of publishedBytes) assert.ok(markdown.includes(bytes), heading);
    for (const model of models) {
      if (!model.owner) {
        assert.equal(ledger.claims.has(model.id), false);
        await assert.rejects(readReleaseCorrectionView(root, released.name, model.id), { code: "correction_missing" });
        continue;
      }
      const owner = model.owner;
      assert.equal(ledger.claims.get(model.id)!.milestone.fingerprint, owner.capture.fingerprint);
      assert.equal(ledger.claims.get(model.id)!.item.title, owner.title);
      assert.equal(summary.filter((row) => row.id === model.id).length, 1);
      assert.equal(summary.find((row) => row.id === model.id)!.title, owner.title);
      let view = await readReleaseCorrectionView(root, owner.capture.name, model.id);
      assert.equal(view.original, owner.title);
      if (!model.correction) {
        assert.equal(view.chain.length, 0);
        model.correction = request(owner.capture, model.id);
        assert.equal((await appendReleaseCorrection(root, model.correction)).changed, true);
        if (model.seed & 4) {
          view = await readReleaseCorrectionView(root, owner.capture.name, model.id);
          await appendReleaseCorrection(root, { ...model.correction, id: "second", supersedes: "first", expectedRevision: view.revision, wording: model.seed & 8 ? model.correction.wording : `Further review ${model.id}` });
        }
      }
      assert.equal((await appendReleaseCorrection(root, model.correction)).changed, false);
      view = await readReleaseCorrectionView(root, owner.capture.name, model.id);
      assert.equal(view.chain.length, model.seed & 4 ? 2 : 1);
      assert.equal(view.chain[0].wording, model.correction.wording);
      assert.equal(view.current, model.seed & 4 && !(model.seed & 8) ? `Further review ${model.id}` : model.correction.wording);
      for (const format of ["json", "toon"] as const) {
        const text = formatReleaseCorrectionView(view, format);
        assert.deepEqual(format === "json" ? JSON.parse(text) : decode(text), view);
      }
      const native = (await client.get(model.id, { full: true })).item;
      for (const [key, value] of Object.entries(model.native!)) if (!["notes", "notes_count", "updated_at", "collection_counts"].includes(key)) assert.deepEqual(native[key], value, `${model.id}:${key}`);
      for (const prior of captures) if (prior.name !== owner.capture.name) await assert.rejects(readReleaseCorrectionView(root, prior.name, model.id), { code: "correction_missing" });
    }
    const currentRegistry = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
    const reread = resolveTrackerReleaseHistory(await readReleaseMilestones(store), [], currentRegistry);
    assert.equal(createChangelog(reread).markdown, markdown);
  }
  assert.deepEqual([...releaseCounts].sort(), [2, 3, 4]); assert.deepEqual([...seenDispositions].sort(), [...dispositions].sort());
  assert.equal(models.filter((model) => model.owner).length, 500);
  for (const model of models) {
    const notes = await client.notes(model.id, { limit: "10001", includeMeta: true, outputBudget: "unbounded", outputLimit: "unbounded" });
    assert.ok("count" in notes);
    assert.equal(notes.count, model.seed & 4 ? 2 : 1);
  }
  t.diagnostic("seed=0x291f4 lifecycles=500 releases=2-4; native reopen/closure/repair, SDK roles before/after publication, JSON/TOON/older replays, immutable Markdown and current correction chains");
});


test("the producer's empty-title filter cannot reserve a later published claim", async (t) => {
  const { root, client, store, capture } = await tracker(t);
  await runCreate({ id: "life-empty", title: "Native repair", type: "Issue", status: "closed", closeReason: "Fixed parser failure", createMode: "progressive", unset }, { path: root, author: "lifecycle" });
  const snapshot = await readTrackerReleaseSnapshot(root);
  // A backend adapter can carry legacy empty titles; the released schema accepts them.
  const empty = await createReleaseMilestone(store, "v1", { ...snapshot, items: snapshot.items.map((item) => ({ ...item, title: "" })) });
  assert.equal(resolveTrackerReleaseLedger([empty]).claims.size, 0);
  await assert.rejects(readReleaseCorrectionView(root, "v1", "life-empty"), { code: "correction_missing" });
  await update(client, "life-empty", { title: "Published repair", status: "closed", closeReason: "Fixed parser failure" });
  const current = await readTrackerReleaseSnapshot(root);
  const fixed = await createReleaseMilestone(store, "v2", { ...current, capturedAt: new Date(Math.max(Date.parse(current.capturedAt), Date.parse(empty.capturedAt) + 1)).toISOString() });
  assert.equal(resolveTrackerReleaseLedger([empty, fixed]).claims.get("life-empty")!.milestone.name, "v2");
  assert.equal((await readReleaseCorrectionView(root, "v2", "life-empty")).original, "Published repair");
  assert.deepEqual(await store.read("v1"), empty);
});
