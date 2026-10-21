import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runInit, runCreate } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import extension from "../src/extension.ts";
import { cliTestSurface } from "../src/cli.ts";
import { createChangelog } from "../src/generator.ts";
import {
  DirectoryReleaseMilestoneStore, ReleaseMilestoneError, assertTrackerMilestoneOptions,
  MissingTagHistoryError, resolveReleaseTagWindows,
  createReleaseMilestone, parseReleaseMilestone, readReleaseMilestones,
  readTrackerReleaseSnapshot, resolveTrackerReleaseHistory,
} from "../src/index.ts";
import type { ReleaseMilestone, ReleaseMilestoneStore, TrackerReleaseSnapshot, PmItem } from "../src/index.ts";

/** A real transactional SQL implementation of the public immutable store contract. */
class SqlStore implements ReleaseMilestoneStore {
  readonly db = new DatabaseSync(":memory:");
  constructor() { this.db.exec("CREATE TABLE milestones (name TEXT PRIMARY KEY, payload TEXT NOT NULL)"); }
  async read(name: string): Promise<unknown | undefined> {
    const row = this.db.prepare("SELECT payload FROM milestones WHERE name = ?").get(name);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  async publish(name: string, value: ReleaseMilestone): Promise<boolean> {
    return this.db.prepare("INSERT OR IGNORE INTO milestones VALUES (?, ?)").run(name, JSON.stringify(value)).changes === 1;
  }
  async names(): Promise<string[]> { return this.db.prepare("SELECT name FROM milestones ORDER BY name").all().map((row) => String(row.name)); }
}

/** Stable snapshots model an early close, a late close and an item outside any release. */
const initial: TrackerReleaseSnapshot = {
  capturedAt: "2026-10-01T12:00:00Z",
  items: [
    { id: "test-early", title: "Original delivered feature", type: "Feature", status: "closed", tags: ["ship"], completed_at: "2026-09-30T00:00:00Z" },
    { id: "test-late", title: "Late close", type: "Task", status: "open", tags: [] },
  ],
};

/** Assert the typed refusal and its executable recovery receipt. */
function refusal(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof ReleaseMilestoneError);
    assert.equal(error.code, code);
    assert.ok(error.remedy.length);
    return true;
  };
}

test("directory and real SQL milestones produce identical notes with exact membership and late-close attribution", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-release-boundaries-"));
  const directory = new DirectoryReleaseMilestoneStore(root);
  const sql = new SqlStore();
  const current: PmItem[] = [
    { ...initial.items[0]!, title: "Edited later", status: "open" },
    { ...initial.items[1]!, title: "Late delivered feature", status: "closed", completed_at: "2026-10-10T00:00:00Z", release: "wrong", metadata: { release: "wrong" } },
    { id: "test-outside", title: "Unreleased work", status: "closed" },
    { title: "No identity", status: "closed" },
  ];
  try {
    assert.deepEqual(await directory.names(), []);
    await assert.rejects(readReleaseMilestones(directory), refusal("milestone_missing"));
    for (const store of [directory, sql]) {
      const one = await createReleaseMilestone(store, "one", initial);
      assert.deepEqual(one.items.map((item) => item.id), ["test-early", "test-late"]);
      assert.deepEqual(await createReleaseMilestone(store, "one", { capturedAt: "2026-10-11T00:00:00Z", items: current.slice(0, 2) }), one);
      await assert.rejects(createReleaseMilestone(store, "one", initial, "status:closed"), refusal("milestone_membership_changed"));
      await createReleaseMilestone(store, "two", { capturedAt: "2026-10-02T12:00:00Z", items: initial.items });
    }
    const fromDirectory = resolveTrackerReleaseHistory(await readReleaseMilestones(directory), current);
    const fromDatabase = resolveTrackerReleaseHistory(await readReleaseMilestones(sql), current);
    const notes = createChangelog(fromDirectory);
    assert.equal(notes.markdown, createChangelog(fromDatabase).markdown);
    assert.equal(notes.itemCount, 3);
    assert.match(notes.markdown, /## one - 2026-10-01[\s\S]*Late delivered feature[\s\S]*Original delivered feature/);
    assert.doesNotMatch(notes.markdown, /Edited later|## two|wrong|No identity/);
    assert.equal(notes.markdown.split("Late delivered feature").length, 2);
    assert.equal(fromDirectory.releaseMembership.get("test-outside"), "Unreleased");
    // Missing current rows cannot erase frozen delivered notes or invent closure.
    const missing = resolveTrackerReleaseHistory(await readReleaseMilestones(directory), []);
    assert.equal(createChangelog(missing).itemCount, 1);
  } finally { sql.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("queries, content verification, idempotence and concurrent publication fail closed", async () => {
  const sql = new SqlStore();
  const root = mkdtempSync(join(tmpdir(), "pm-release-races-"));
  const store = new DirectoryReleaseMilestoneStore(root);
  try {
    const selected = await createReleaseMilestone(sql, "filtered", initial, "type:Feature,Issue tag:ship id:test-early status:closed release:undefined");
    assert.equal(selected.items.length, 1);
    assert.equal((await createReleaseMilestone(sql, "no-tag", initial, "tag:missing")).items.length, 0);
    assert.throws(() => assertTrackerMilestoneOptions([true]), refusal("milestone_options"));
    assertTrackerMilestoneOptions([false, undefined, ""]);
    await assert.rejects(createReleaseMilestone(sql, "bad", initial, "unsupported"), refusal("milestone_invalid"));
    await assert.rejects(createReleaseMilestone(sql, "../escape", initial), refusal("milestone_invalid"));
    const good = await createReleaseMilestone(sql, "original", initial);
    const malformed: unknown[] = [null, {}, { ...good, capturedAt: "bad" }, { ...good, fingerprint: "wrong" }, { ...good, items: [null] }, { ...good, items: [{ title: "No ID" }] }, { ...good, items: [{ id: " ", title: "Blank ID" }] }, { ...good, items: [{ id: "test", title: 2 }] }, { ...good, items: [good.items[0], good.items[0]] }];
    for (const value of malformed) assert.throws(() => parseReleaseMilestone(value), refusal("milestone_invalid"));
    await assert.rejects(createReleaseMilestone(sql, "duplicate", { ...initial, items: [initial.items[0]!, initial.items[0]!] }), refusal("milestone_invalid"));
    sql.db.prepare("INSERT INTO milestones VALUES (?, ?)").run("alias", JSON.stringify(good));
    await assert.rejects(readReleaseMilestones(sql), refusal("milestone_invalid"));
    await assert.rejects(createReleaseMilestone(sql, "alias", initial), refusal("milestone_membership_changed"));
    const races = await Promise.all(Array.from({ length: 4 }, () => createReleaseMilestone(store, "race", initial)));
    assert.ok(races.every((value) => value.fingerprint === races[0]!.fingerprint));
    assert.deepEqual(await store.names(), ["race"]);
    const other = await createReleaseMilestone(sql, "tie", initial);
    assert.throws(() => resolveTrackerReleaseHistory([good, good], []), refusal("milestone_invalid"));
    const state = resolveTrackerReleaseHistory([good, other], []);
    assert.equal(state.items.length, 2);
  } finally { sql.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("directory storage reports recoverable read, list and publication faults", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-release-storage-"));
  const store = new DirectoryReleaseMilestoneStore(root);
  try {
    mkdirSync(store.directory, { recursive: true });
    writeFileSync(join(store.directory, "broken.json"), "{");
    await assert.rejects(store.read("broken"), refusal("milestone_storage"));
    await assert.rejects(store.read("../escape"), refusal("milestone_invalid"));
    const milestone = await createReleaseMilestone(store, "valid", initial);
    const blocked = new DirectoryReleaseMilestoneStore(join(root, "blocked"));
    mkdirSync(join(root, "blocked"));
    writeFileSync(join(root, "blocked", "changelog"), "not a directory");
    await assert.rejects(blocked.names(), refusal("milestone_storage"));
    await assert.rejects(blocked.publish("valid", milestone));
    await assert.rejects(store.publish("..", milestone), refusal("milestone_invalid"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real plain tracker CLI and extension freeze and generate without a git executable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pm-release-nogit-"));
  const pmRoot = join(root, ".agents", "pm");
  const originalPath = process.env.PATH;
  const originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
  const noGit = join(root, "bin");
  mkdirSync(noGit);
  symlinkSync(process.execPath, join(noGit, "node"));
  process.env.PATH = noGit;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  try {
    await runInit("pm", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
    await runCreate({ id: "pm-early", title: "Real tracker delivery", type: "Task", status: "closed", closeReason: "Delivered", createMode: "progressive" }, { path: pmRoot });
    const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] });
    assert.deepEqual(activation.failed, []);
    const created = await runRegisteredCommandForTest(activation.commands, { command: "changelog milestone create", pmRoot, args: ["real"], options: { items: "status:closed" } });
    assert.ok(created.result && typeof created.result === "object" && "item_count" in created.result && created.result.item_count === 1);
    assert.ok(JSON.stringify(created.result).length < 250);
    await runRegisteredCommandForTest(activation.commands, { command: "changelog milestone create", pmRoot, args: ["all"] });
    await assert.rejects(runRegisteredCommandForTest(activation.commands, { command: "changelog milestone create", pmRoot }), refusal("milestone_invalid"));
    const result = await runRegisteredCommandForTest(activation.commands, { command: "changelog generate", pmRoot, options: { milestones: true, stdout: true } });
    assert.ok(result.result && typeof result.result === "object" && "changelog" in result.result);
    assert.match(String(result.result.changelog), /Real tracker delivery/);
    await assert.rejects(runRegisteredCommandForTest(activation.commands, { command: "changelog generate", pmRoot, options: { milestones: true, "all-release-tags": true } }), refusal("milestone_options"));
    const extensionRoot = join(pmRoot, "extensions", "pm-changelog");
    mkdirSync(extensionRoot, { recursive: true });
    const manifest = JSON.parse(readFileSync(resolve("manifest.json"), "utf8"));
    writeFileSync(join(extensionRoot, "manifest.json"), JSON.stringify({ ...manifest, entry: "./index.mjs" }));
    writeFileSync(join(extensionRoot, "index.mjs"), `export { default } from ${JSON.stringify(pathToFileURL(resolve("dist/extension.js")).href)};`);
    const cli = resolve("dist/cli.js");
    const env = { ...process.env, PATH: noGit, GIT_CEILING_DIRECTORIES: dirname(root), PM_GLOBAL_PATH: join(root, "global"), DO_NOT_TRACK: "1" };
    const host = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
    const hostCreate = spawnSync(process.execPath, [host, "--path", pmRoot, "changelog", "milestone", "create", "host-release", "--items", "status:closed", "--json"], { cwd: root, env, encoding: "utf8" });
    assert.equal(hostCreate.status, 0, hostCreate.stderr);
    assert.equal(JSON.parse(hostCreate.stdout).item_count, 1);
    const hostToon = spawnSync(process.execPath, [host, "--path", pmRoot, "changelog", "milestone", "create", "host-release", "--items", "status:closed"], { cwd: root, env, encoding: "utf8" });
    assert.equal(hostToon.status, 0, hostToon.stderr);
    assert.match(hostToon.stdout, /item_count: 1/);
    const generated = spawnSync(process.execPath, [cli, "--milestones", "--pm-root", pmRoot, "--stdout"], { cwd: root, env, encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(generated.stdout, /Real tracker delivery/);
    const compact = spawnSync(process.execPath, [cli, "--milestones", "--pm-root", pmRoot, "--summary", "--format", "json"], { cwd: root, env, encoding: "utf8" });
    assert.equal(compact.status, 0, compact.stderr);
    assert.equal(JSON.parse(compact.stdout).item_count, 1);
    const refused = spawnSync(process.execPath, [cli, "--milestones", "--pm-root", pmRoot, "--all-release-tags"], { cwd: root, env, encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /milestones cannot be combined/);
    assert.equal((await readTrackerReleaseSnapshot(pmRoot)).items.length, 1);
    assert.throws(() => resolveReleaseTagWindows({ cwd: root }), (error: unknown) => {
      assert.ok(error instanceof MissingTagHistoryError);
      assert.match(error.message, /needs a git repository.*not inside one/);
      assert.match(error.message, /--milestones still work/);
      return true;
    });
    const writes: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
    await cliTestSurface.main(["--milestones", "--pm-root", pmRoot, "--stdout"]);
    assert.match(writes.join(""), /Real tracker delivery/);
    writes.length = 0;
    await cliTestSurface.main(["--milestones", "--pm-cwd", root, "--pm-root", ".agents/pm", "--summary", "--format", "json"]);
    assert.equal(JSON.parse(writes.join("")).item_count, 1);
    await assert.rejects(cliTestSurface.main(["--milestones", "--all-release-tags"]), refusal("milestone_options"));
    const error = JSON.parse(cliTestSurface.errorMessage(new ReleaseMilestoneError("milestone_missing", "Missing", "Create a milestone")));
    assert.equal(error.error.code, "milestone_missing");
    assert.equal(error.error.remedy, "Create a milestone");
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
    rmSync(root, { recursive: true, force: true });
  }
});
