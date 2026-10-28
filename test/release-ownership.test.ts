import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { decode } from "@toon-format/toon";
import { PmClient, readSettings, resolveRuntimeStatusRegistry, runCreate, runInit, schemaAddStatus } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import extension from "../src/extension.ts";
import { appendReleaseCorrection, createChangelog, createReleaseMilestone, DirectoryReleaseMilestoneStore, formatReleaseCorrectionView, readReleaseCorrectionView, readReleaseMilestones, readTrackerReleaseSnapshot, ReleaseCorrectionError, parseReleaseCorrection, resolveTrackerReleaseHistory, resolveTrackerReleaseLedger } from "../src/index.ts";
import type { ReleaseCorrectionInput, ReleaseMilestone, ReleaseMilestoneStore } from "../src/index.ts";

/** Assert that a wrong-release request refuses with a usable remedy. */
function wrongRelease(error: unknown): boolean {
  assert.ok(error instanceof ReleaseCorrectionError);
  assert.equal(error.code, "correction_missing");
  assert.ok(error.remedy.length);
  return true;
}

/** Real SDK states model early active captures, first publication, later edits and reopenings. */
async function catalog(t: { after(fn: () => void): void }) {
  const cwd = mkdtempSync(join(tmpdir(), "pm-first-publication-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, ".agents/pm");
  await runInit("own", { path: root }, { defaults: true, agentGuidance: "skip" });
  await schemaAddStatus("active_named_done", { role: ["terminal", "terminal_done"] }, { pmRoot: root });
  const client = new PmClient({ pmRoot: root, author: "fixture" });
  for (const suffix of ["early", "late", "custom", "never"]) await runCreate({ id: `own-${suffix}`, title: `Active ${suffix}`, type: "Feature", status: "open", createMode: "progressive", unset: ["parent", "goal", "objective", "sprint", "release"] }, { path: root, author: "fixture" });
  const store = new DirectoryReleaseMilestoneStore(root);
  const captures: ReleaseMilestone[] = [];
  const capture = async (name: string): Promise<void> => {
    const snapshot = await readTrackerReleaseSnapshot(root);
    captures.push(await createReleaseMilestone(store, name, { ...snapshot, capturedAt: `2026-10-0${captures.length + 1}T00:00:00Z` }));
  };
  await capture("z-active");
  await client.close("own-early", "Delivered");
  await client.update("own-custom", { status: "active_named_done", closeReason: "Delivered", unset: ["parent", "goal", "objective", "sprint", "release"] });
  await capture("z-first");
  await client.update("own-early", { title: "Edited after publication", unset: ["parent", "goal", "objective", "sprint", "release"] });
  await client.update("own-custom", { title: "Custom wording edited later", unset: ["parent", "goal", "objective", "sprint", "release"] });
  await client.close("own-late", "Delivered");
  await capture("a-recapture");
  await client.reopen("own-early", "Resume active work");
  await capture("b-reopen");
  const registry = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
  return { cwd, root, store, client, captures, registry };
}

/** Bind a candidate correction to the exact snapshot that a caller tries to correct. */
function correction(milestone: ReleaseMilestone, item: string): ReleaseCorrectionInput {
  return { schema: 1, release: milestone.name, item, milestone: milestone.fingerprint, id: "accuracy", supersedes: "", expectedRevision: milestone.fingerprint, wording: "Reviewed factual wording", evidence: ["docs/release-corrections.md"] };
}

test("first-release ledger is invariant across 500 catalog permutations and preserves original SDK rows", async (t) => {
  const { root, client, captures, registry } = await catalog(t);
  const native = await client.get("own-early", { fields: "id,title,status" });
  assert.equal(native.item.title, "Edited after publication");
  const expected = new Map([["own-early", captures[1]], ["own-custom", captures[1]], ["own-late", captures[2]]]);
  let seed = 0x291f1;
  for (let sequence = 0; sequence < 500; sequence++) {
    const shuffled = [...captures];
    for (let index = shuffled.length - 1; index > 0; index--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const other = seed % (index + 1);
      [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
    }
    const ledger = resolveTrackerReleaseLedger(shuffled, registry);
    const history = resolveTrackerReleaseHistory(shuffled, [], registry);
    assert.equal(ledger.claims.size, expected.size);
    for (const [item, owner] of expected) {
      const claim = ledger.claims.get(item)!;
      assert.equal(claim.milestone.name, owner.name);
      assert.deepEqual(claim.item, owner.items.find((row) => row.id === item));
      assert.equal(history.releaseMembership.get(item), `${owner.name} - ${owner.capturedAt.slice(0, 10)}`);
      assert.equal(history.items.find((row) => row.id === item)!.title, claim.item.title);
    }
    assert.equal(ledger.claims.has("own-never"), false);
    assert.match(createChangelog(history).markdown, /Active custom/);
    assert.doesNotMatch(createChangelog(history).markdown, /Edited after publication|Custom wording edited later/);
  }
  for (const [item, owner] of expected) {
    const view = await readReleaseCorrectionView(root, owner.name, item);
    assert.equal(view.original, owner.items.find((row) => row.id === item)!.title);
    for (const format of ["json", "toon"] as const) {
      const text = formatReleaseCorrectionView(view, format);
      assert.deepEqual(format === "json" ? JSON.parse(text) : decode(text), view);
    }
    for (const candidate of captures.filter((entry) => entry !== owner)) {
      await assert.rejects(readReleaseCorrectionView(root, candidate.name, item), wrongRelease);
      await assert.rejects(appendReleaseCorrection(root, correction(candidate, item)), wrongRelease);
    }
    assert.equal((await client.notes(item)).count, 0);
  }
  t.diagnostic("seed=0x291f1 catalog permutations=500; 3 owning claims; 4 captures; wrong-release reads and appends refuse");
});

test("later snapshots and legacy mistargeted events cannot steal a first published claim", async (t) => {
  const { root, client, captures } = await catalog(t);
  const original = captures[1], later = captures[2];
  // This is a durable event an earlier buggy client could have written; retain it as unrelated.
  await client.notes("own-early", { addJson: JSON.stringify({ type: "pm-changelog.release-correction", correction: parseReleaseCorrection(correction(later, "own-early")) }) });
  const before = await readReleaseCorrectionView(root, original.name, "own-early");
  assert.equal(before.original, "Active early"); assert.equal(before.chain.length, 0); assert.equal(before.skipped.unrelated, 1);
  await assert.rejects(appendReleaseCorrection(root, correction(later, "own-early")), wrongRelease);
  const result = await appendReleaseCorrection(root, correction(original, "own-early"));
  assert.equal(result.changed, true); assert.equal(result.view.original, "Active early");
  assert.equal(result.view.chain.length, 1); assert.equal(result.view.skipped.unrelated, 1);
  assert.equal((await appendReleaseCorrection(root, correction(original, "own-early"))).changed, false);
  assert.equal((await client.notes("own-early")).count, 2);
});

test("correction reads refuse a selector whose identity changes during catalog resolution", async (t) => {
  const { cwd, root, store, client, captures } = await catalog(t);
  const owner = captures[1];
  const changed = await createReleaseMilestone(new DirectoryReleaseMilestoneStore(join(cwd, "other-backend")), owner.name, {
    capturedAt: owner.capturedAt, items: owner.items.map((item) => ({ ...item, title: "Changed backend content" })),
  });
  for (const requested of [captures[2], changed]) {
    let reads = 0;
    const racing: ReleaseMilestoneStore = {
      names: () => store.names(),
      read: (name) => ++reads === 1 ? Promise.resolve(requested) : store.read(name),
      publish: (name, value) => store.publish(name, value),
    };
    await assert.rejects(readReleaseCorrectionView(root, owner.name, "own-early", { milestones: racing }), wrongRelease);
  }
  assert.equal((await client.notes("own-early")).count, 0);
});

test("standalone and registered host paths enforce the same owning release in JSON and TOON without git", async (t) => {
  const { cwd, root, captures } = await catalog(t);
  const extensionRoot = join(root, "extensions/pm-changelog");
  mkdirSync(extensionRoot, { recursive: true });
  cpSync(resolve("dist"), join(extensionRoot, "dist"), { recursive: true });
  cpSync(resolve("manifest.json"), join(extensionRoot, "manifest.json"));
  writeFileSync(join(extensionRoot, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(resolve("node_modules"), join(extensionRoot, "node_modules"), "junction");
  const noGit = join(cwd, "bin"); mkdirSync(noGit);
  const childEnv = { ...process.env, PATH: noGit, PM_PATH: root, PM_AUTHOR: "fixture", PM_GLOBAL_PATH: join(cwd, "global"), GIT_CEILING_DIRECTORIES: dirname(cwd), DO_NOT_TRACK: "1" };
  const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] });
  assert.deepEqual(activation.failed, []);
  const file = join(cwd, "wrong.json"); writeFileSync(file, JSON.stringify(correction(captures[2], "own-early")));
  for (const format of ["json", "toon"] as const) {
    await assert.rejects(runRegisteredCommandForTest(activation.commands, { command: "changelog corrections", pmRoot: root, args: ["view"], options: { release: captures[2].name, item: "own-early", format } }), wrongRelease);
    await assert.rejects(runRegisteredCommandForTest(activation.commands, { command: "changelog corrections", pmRoot: root, args: ["append"], options: { input: file, format } }), wrongRelease);
    for (const command of [[resolve("dist/cli.js"), "corrections", "--pm-root", root], [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", root, "changelog", "corrections"]]) {
      for (const action of [["view", "--release", captures[2].name, "--item", "own-early"], ["append", "--input", file]]) {
        const refused = spawnSync(process.execPath, [...command, ...action, "--format", format], { cwd, env: childEnv, encoding: "utf8" });
        assert.notEqual(refused.status, 0, refused.stdout); assert.match(refused.stderr, /correction_missing/);
      }
      const viewed = spawnSync(process.execPath, [...command, "view", "--release", captures[1].name, "--item", "own-early", "--format", format], { cwd, env: childEnv, encoding: "utf8" });
      assert.equal(viewed.status, 0, viewed.stderr);
      assert.equal((format === "json" ? JSON.parse(viewed.stdout) : decode(viewed.stdout) as { original: string }).original, "Active early");
    }
  }
  const generated = spawnSync(process.execPath, [resolve("dist/cli.js"), "--pm-root", root, "--milestones", "--stdout"], { cwd, env: childEnv, encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr); assert.match(generated.stdout, /Active custom/); assert.doesNotMatch(generated.stdout, /Edited after publication/);
  const filtered = spawnSync(process.execPath, [resolve("dist/cli.js"), "--pm-root", root, "--milestones", "--stdout", "--status", "open"], { cwd, env: childEnv, encoding: "utf8" });
  assert.equal(filtered.status, 0, filtered.stderr); assert.match(filtered.stdout, /Active never/); assert.doesNotMatch(filtered.stdout, /Active custom/);
  const host = await runRegisteredCommandForTest(activation.commands, { command: "changelog generate", pmRoot: root, options: { milestones: true, stdout: true } });
  assert.ok(host.result && typeof host.result === "object" && "changelog" in host.result); assert.match(String(host.result.changelog), /Active custom/);
  const hostFiltered = await runRegisteredCommandForTest(activation.commands, { command: "changelog generate", pmRoot: root, options: { milestones: true, stdout: true, status: "open" } });
  assert.ok(hostFiltered.result && typeof hostFiltered.result === "object" && "changelog" in hostFiltered.result);
  assert.match(String(hostFiltered.result.changelog), /Active never/); assert.doesNotMatch(String(hostFiltered.result.changelog), /Active custom/);
});
