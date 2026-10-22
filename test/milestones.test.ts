import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runInit, runCreate } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import extension from "../src/extension.ts";
import { initGitFixture } from "./git-fixture.ts";
import { cliTestSurface } from "../src/cli.ts";
import { createChangelog } from "../src/generator.ts";
import {
  DirectoryReleaseMilestoneStore, ReleaseMilestoneError, assertTrackerMilestoneOptions,
  MissingTagHistoryError, assertReleaseTagHistory, resolveReleaseTagWindows,
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
    if (this.db.prepare("SELECT name FROM milestones WHERE name = ?").get(name)) return false;
    const times = this.db.prepare("SELECT payload FROM milestones").all().map((row) => Date.parse((JSON.parse(String(row.payload)) as ReleaseMilestone).capturedAt));
    if (times.some((time) => Date.parse(value.capturedAt) <= time)) throw new ReleaseMilestoneError("milestone_invalid", "Capture clock did not advance.", "Obtain a newer snapshot.");
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

test("milestone fingerprints and attribution use portable code-unit ordering", async () => {
  const sql = new SqlStore();
  const snapshot: TrackerReleaseSnapshot = {
    capturedAt: "2026-10-01T12:00:00Z",
    items: [
      { id: "ä", title: "Unicode", status: "closed", metadata: { release: "v1", milestone: "m1", breaking: true, absent: undefined } },
      { id: "z", title: "Lowercase", status: "closed" },
      { id: "A", title: "Uppercase", status: "closed" },
    ],
  };
  try {
    const first = await createReleaseMilestone(sql, "z", snapshot);
    assert.deepEqual(first.items.map((item) => item.id), ["A", "z", "ä"]);
    assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
    const reordered = JSON.parse(JSON.stringify(first)) as ReleaseMilestone;
    reordered.items[2]!.metadata = { breaking: true, milestone: "m1", release: "v1" };
    assert.deepEqual(parseReleaseMilestone(reordered), first);
    const second = await createReleaseMilestone(sql, "a", { ...snapshot, capturedAt: "2026-10-02T12:00:00Z", items: snapshot.items.map((item) => ({ ...item, title: "Other completion" })) });
    for (const boundaries of [[second, first], [first, second]]) {
      const history = resolveTrackerReleaseHistory(boundaries, []);
      assert.equal(history.releaseMembership.get("A"), "z - 2026-10-01");
      assert.equal(history.items[0]!.title, "Uppercase");
    }
  } finally { sql.db.close(); }
});

test("milestone JSON snapshots retain verifiable fingerprints after storage and adapter reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-release-json-"));
  const sql = new SqlStore();
  const directory = new DirectoryReleaseMilestoneStore(root);
  const metadata = {
    release: new Date("2026-10-01T12:00:00Z"),
    milestone: { toJSON: () => ({ delivered: true }) },
    breaking: [undefined, , NaN, Infinity],
    absent: undefined,
  };
  const snapshot: TrackerReleaseSnapshot = {
    ...initial, items: [{ ...initial.items[0]!, metadata }],
  };
  const normalized = JSON.parse(JSON.stringify(snapshot)) as TrackerReleaseSnapshot;
  try {
    for (const store of [sql, directory]) {
      const expected = await createReleaseMilestone(store, "normalized", normalized);
      const created = await createReleaseMilestone(store, "adapter", { ...snapshot, capturedAt: "2026-10-02T12:00:00Z" });
      assert.deepEqual(created.items, expected.items);
      assert.deepEqual(created.items[0]!.metadata, {
        release: "2026-10-01T12:00:00.000Z", milestone: { delivered: true }, breaking: [null, null, null, null],
      });
      assert.deepEqual(parseReleaseMilestone(await store.read("adapter")), created);
      assert.deepEqual(await readReleaseMilestones(store), [created, expected]);
      assert.deepEqual(await createReleaseMilestone(store, "adapter", snapshot), created);
      assert.equal(createChangelog(resolveTrackerReleaseHistory([created], [])).itemCount, 1);
      // A remote adapter can return rich values with the persisted JSON fingerprint.
      assert.deepEqual(parseReleaseMilestone({ ...created, items: [{ ...created.items[0]!, metadata }] }), created);
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      for (const invalid of [undefined, { ...created, items: [{ ...created.items[0], metadata: cyclic }] }, { ...created, items: [{ ...created.items[0], metadata: { value: 1n } }] }]) {
        assert.throws(() => parseReleaseMilestone(invalid), refusal("milestone_invalid"));
      }
    }
  } finally { sql.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("open milestone members remain Unreleased until their first closed capture", async () => {
  const sql = new SqlStore();
  try {
    const open = { id: "later", title: "Open at v1", status: "open" };
    const closed = { ...open, title: "Closed at v2", status: "closed" };
    const v1 = await createReleaseMilestone(sql, "v1", { capturedAt: "2026-10-01T00:00:00Z", items: [open] });
    const before = resolveTrackerReleaseHistory([v1], [closed]);
    assert.equal(before.releaseMembership.get(open.id), "Unreleased");
    assert.equal(createChangelog(before).sections.find((section) => section.items.length)!.heading, "Unreleased");
    const v2 = await createReleaseMilestone(sql, "v2", { capturedAt: "2026-10-02T00:00:00Z", items: [closed] });
    for (const current of [[], [open], [{ ...closed, title: "Edited afterward" }]]) {
      const history = resolveTrackerReleaseHistory([v2, v1], current);
      assert.equal(history.releaseMembership.get(open.id), "v2 - 2026-10-02");
      assert.equal(history.items[0]!.title, closed.title);
      assert.equal(createChangelog(history).sections.find((section) => section.items.length)!.heading, "v2 - 2026-10-02");
    }
    assert.equal(createChangelog(resolveTrackerReleaseHistory([v1], [])).itemCount, 0);
    const independent = new SqlStore();
    const equalTime = await createReleaseMilestone(independent, "other", { capturedAt: v1.capturedAt, items: [closed] });
    independent.db.close();
    assert.throws(() => resolveTrackerReleaseHistory([v1, equalTime], []), refusal("milestone_invalid"));
  } finally { sql.db.close(); }
});

test("milestone creation refuses backward or equal capture clocks", async () => {
  const sql = new SqlStore();
  try {
    const first = await createReleaseMilestone(sql, "first", initial);
    for (const capturedAt of ["2026-10-01T11:59:59Z", initial.capturedAt, "2026-10-01T14:00:00+02:00"]) {
      await assert.rejects(createReleaseMilestone(sql, "skewed", { ...initial, capturedAt }), refusal("milestone_invalid"));
      assert.equal(await sql.read("skewed"), undefined);
    }
    assert.deepEqual(await createReleaseMilestone(sql, "first", initial), first);
    await createReleaseMilestone(sql, "later", { ...initial, capturedAt: "2026-10-01T12:00:01Z" });
  } finally { sql.db.close(); }
});

test("milestone capture times require valid RFC3339 offsets", async () => {
  const sql = new SqlStore();
  try {
    for (const capturedAt of ["2026-10-01", "2026-10-01T12:00:00", "October 1, 2026", "2026-02-30T00:00:00Z", "2026-99-01T00:00:00Z", "2026-10-01T24:00:00Z", "2026-10-01T12:00:00+25:00"]) {
      await assert.rejects(createReleaseMilestone(sql, "invalid-time", { ...initial, capturedAt }), refusal("milestone_invalid"));
    }
    const valid = await createReleaseMilestone(sql, "offset", { ...initial, capturedAt: "2026-10-01T14:00:00.123+02:00" });
    assert.equal(valid.capturedAt, "2026-10-01T14:00:00.123+02:00");
  } finally { sql.db.close(); }
});

test("milestone snapshots omit bodies and unrelated tracker fields", async () => {
  const sql = new SqlStore();
  try {
    const row = { ...initial.items[0]!, body: "PRIVATE BODY", description: "PRIVATE DESCRIPTION", metadata: { private_note: "PRIVATE METADATA", breaking: true }, comments: ["PRIVATE COMMENT"], files: [{ path: "src/parser.ts", note: "PRIVATE FILE NOTE" }] };
    const saved = await createReleaseMilestone(sql, "compact", { ...initial, items: [row] });
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE/);
    assert.deepEqual(saved.items[0]!.metadata, { breaking: true });
    assert.deepEqual(saved.items[0]!.files, [{ path: "src/parser.ts" }]);
    const fresh = new SqlStore();
    const redacted = await createReleaseMilestone(fresh, "compact", { ...initial, items: [Object.assign({}, row, { body: "redacted", description: "redacted", metadata: { breaking: true }, comments: [] })] });
    fresh.db.close();
    assert.equal(redacted.fingerprint, saved.fingerprint);
    assert.equal(createChangelog(resolveTrackerReleaseHistory([saved], [])).itemCount, 1);
  } finally { sql.db.close(); }
});

test("milestone names reject case variants before touching storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-release-case-"));
  try {
    const store = new DirectoryReleaseMilestoneStore(root);
    await assert.rejects(createReleaseMilestone(store, "UPPERCASE", initial), refusal("milestone_invalid"));
    await createReleaseMilestone(store, "v1", initial);
    await assert.rejects(createReleaseMilestone(store, "V1", { ...initial, capturedAt: "2026-10-02T00:00:00Z" }), (error: unknown) => {
      assert.ok(error instanceof ReleaseMilestoneError);
      assert.match(error.remedy, /lowercase/);
      return true;
    });
    assert.deepEqual(await store.names(), ["v1"]);
    for (const name of ["con", "nul.txt", "COM1"]) await assert.rejects(createReleaseMilestone(store, name, initial), refusal("milestone_invalid"));
    const legacy = new DirectoryReleaseMilestoneStore(join(root, "legacy"));
    mkdirSync(legacy.directory, { recursive: true });
    writeFileSync(join(legacy.directory, "V1.json"), JSON.stringify(await store.read("v1")));
    await assert.rejects(createReleaseMilestone(legacy, "v1", { ...initial, capturedAt: "2026-10-02T00:00:00Z" }), refusal("milestone_invalid"));
    const insensitive = new SqlStore();
    try {
      const original = {"schema":1,"name":"V1","query":"*","capturedAt":"2026-10-01T12:00:00Z","items":[{"id":"legacy","title":"Legacy closed row","status":"closed"}],"fingerprint":"c2d14298b1c50c7cfd1da1391c7da6ee1f12e4f7329863303a762800f3616586"};
      assert.equal(parseReleaseMilestone(original).name, "V1");
      insensitive.db.prepare("INSERT INTO milestones VALUES (?, ?)").run("v1", JSON.stringify(original));
      await assert.rejects(createReleaseMilestone(insensitive, "v1", { ...initial, capturedAt: "2026-10-02T00:00:00Z" }), refusal("milestone_invalid"));
    } finally { insensitive.db.close(); }

  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows directory publication syncs file data without opening the directory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pm-release-windows-"));
  const store = new DirectoryReleaseMilestoneStore(root);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const realOpen = fsPromises.open;
  const realLink = fsPromises.link;
  const events: string[] = [];
  t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
    if (String(args[0]) === store.directory) {
      throw Object.assign(new Error("directory handles unavailable"), { code: "EPERM" });
    }
    const handle = await realOpen(...args);
    const sync = handle.sync.bind(handle);
    const close = handle.close.bind(handle);
    t.mock.method(handle, "sync", async () => { events.push("file:sync"); return sync(); });
    t.mock.method(handle, "close", async () => { events.push("file:close"); return close(); });
    return handle;
  });
  t.mock.method(fsPromises, "link", async (...args: Parameters<typeof fsPromises.link>) => {
    events.push("link");
    return realLink(...args);
  });
  syncBuiltinESMExports();
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    const milestone = await createReleaseMilestone(store, "windows", initial);
    assert.deepEqual(events, ["file:sync", "file:close", "link"]);
    assert.deepEqual(parseReleaseMilestone(await store.read("windows")), milestone);
    assert.deepEqual(await store.names(), ["windows"]);
    assert.deepEqual((await fsPromises.readdir(store.directory)).filter((entry) => entry.endsWith(".tmp")), []);
  } finally {
    Object.defineProperty(process, "platform", platform);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory publication syncs before linking and cleans up failed writes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pm-release-durable-"));
  const store = new DirectoryReleaseMilestoneStore(root);
  const events: string[] = [];
  let fault: string | undefined;
  const realOpen = fsPromises.open;
  const realLink = fsPromises.link;
  t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
    const handle = await realOpen(...args);
    const kind = String(args[0]) === store.directory ? "directory" : "file";
    const write = handle.writeFile.bind(handle);
    const sync = handle.sync.bind(handle);
    const close = handle.close.bind(handle);
    t.mock.method(handle, "writeFile", async (...values: Parameters<typeof handle.writeFile>) => {
      events.push("file:write");
      if (fault === "file:write") throw new Error("injected write failure");
      return write(...values);
    });
    t.mock.method(handle, "sync", async () => {
      events.push(`${kind}:sync`);
      if (fault === `${kind}:sync`) throw new Error("injected sync failure");
      return sync();
    });
    t.mock.method(handle, "close", async () => { events.push(`${kind}:close`); return close(); });
    return handle;
  });
  t.mock.method(fsPromises, "link", async (...args: Parameters<typeof fsPromises.link>) => {
    events.push("link");
    return realLink(...args);
  });
  syncBuiltinESMExports();
  try {
    const milestone = await createReleaseMilestone(store, "durable", initial);
    const directoryEvents = process.platform === "win32" ? [] : ["directory:sync", "directory:close"];
    assert.deepEqual(events, ["file:write", "file:sync", "file:close", "link", ...directoryEvents]);
    assert.deepEqual(await store.read("durable"), milestone);
    const failures = process.platform === "win32" ? ["file:write", "file:sync"] : ["file:write", "file:sync", "directory:sync"];
    for (const failure of failures) {
      events.length = 0;
      fault = failure;
      const name = failure.replace(":", "-");
      await assert.rejects(createReleaseMilestone(store, name, { ...initial, capturedAt: failure === "directory:sync" ? "2026-10-04T00:00:00Z" : "2026-10-03T00:00:00Z" }), refusal("milestone_storage"));
      assert.ok(events.includes("file:close"));
      assert.deepEqual((await fsPromises.readdir(store.directory)).filter((entry) => entry.endsWith(".tmp")), []);
      if (failure === "directory:sync") {
        assert.ok(events.includes("directory:close"));
        assert.equal((await createReleaseMilestone(store, name, { ...initial, capturedAt: failure === "directory:sync" ? "2026-10-04T00:00:00Z" : "2026-10-03T00:00:00Z" })).name, name);
      } else {
        assert.equal(await store.read(name), undefined);
        assert.ok(!events.includes("link"));
      }
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory and real SQL milestones freeze only closed release entries", async () => {
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
    assert.match(notes.markdown, /## Unreleased[\s\S]*Late delivered feature[\s\S]*## one - 2026-10-01[\s\S]*Original delivered feature/);
    assert.doesNotMatch(notes.markdown, /Edited later|## two|wrong|No identity/);
    assert.equal(notes.markdown.split("Late delivered feature").length, 2);
    assert.equal(fromDirectory.releaseMembership.get("test-outside"), "Unreleased");
    // Missing current rows cannot erase frozen delivered notes or invent closure.
    const missing = resolveTrackerReleaseHistory(await readReleaseMilestones(directory), []);
    assert.equal(createChangelog(missing).itemCount, 1);
    // A captured late close remains shipped even after the live item reopens.
    for (const store of [directory, sql]) {
      await createReleaseMilestone(store, "three", { capturedAt: "2026-10-11T12:00:00Z", items: current.slice(0, 2) });
    }
    const reopened = current.map((item) => item.id === "test-late"
      ? { ...item, status: "open", title: "Late reopened work", completed_at: undefined } : item);
    const historical = resolveTrackerReleaseHistory(await readReleaseMilestones(directory), reopened);
    const historicalNotes = createChangelog(historical);
    assert.equal(historicalNotes.itemCount, 3);
    assert.match(historicalNotes.markdown, /Late delivered feature/);
    assert.doesNotMatch(historicalNotes.markdown, /Late reopened work|Edited later/);
    assert.equal(historical.releaseMembership.get("test-late"), "three - 2026-10-11");
    assert.equal(historicalNotes.markdown, createChangelog(resolveTrackerReleaseHistory(await readReleaseMilestones(sql), reopened)).markdown);
  } finally { sql.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("queries, content verification, idempotence and concurrent publication fail closed", async () => {
  const sql = new SqlStore();
  const root = mkdtempSync(join(tmpdir(), "pm-release-races-"));
  const store = new DirectoryReleaseMilestoneStore(root);
  try {
    const selected = await createReleaseMilestone(sql, "filtered", initial, "type:Feature,Issue tag:ship id:test-early status:closed release:undefined");
    assert.equal(selected.items.length, 1);
    assert.equal((await createReleaseMilestone(sql, "no-tag", { ...initial, capturedAt: "2026-10-02T00:00:00Z" }, "tag:missing")).items.length, 0);
    assert.throws(() => assertTrackerMilestoneOptions([true]), refusal("milestone_options"));
    assertTrackerMilestoneOptions([false, undefined, ""]);
    await assert.rejects(createReleaseMilestone(sql, "bad", initial, "unsupported"), refusal("milestone_invalid"));
    await assert.rejects(createReleaseMilestone(sql, "../escape", initial), refusal("milestone_invalid"));
    const good = await createReleaseMilestone(sql, "original", { ...initial, capturedAt: "2026-10-03T00:00:00Z" });
    const malformed: unknown[] = [null, {}, { ...good, capturedAt: "bad" }, { ...good, fingerprint: "wrong" }, { ...good, items: [null] }, { ...good, items: [{ title: "No ID" }] }, { ...good, items: [{ id: " ", title: "Blank ID" }] }, { ...good, items: [{ id: "test", title: 2 }] }, { ...good, items: [good.items[0], good.items[0]] }];
    for (const value of malformed) assert.throws(() => parseReleaseMilestone(value), refusal("milestone_invalid"));
    await assert.rejects(createReleaseMilestone(sql, "duplicate", { ...initial, items: [initial.items[0]!, initial.items[0]!] }), refusal("milestone_invalid"));
    sql.db.prepare("INSERT INTO milestones VALUES (?, ?)").run("alias", JSON.stringify(good));
    await assert.rejects(readReleaseMilestones(sql), refusal("milestone_invalid"));
    await assert.rejects(createReleaseMilestone(sql, "alias", initial), refusal("milestone_membership_changed"));
    const races = await Promise.all(Array.from({ length: 4 }, () => createReleaseMilestone(store, "race", initial)));
    assert.ok(races.every((value) => value.fingerprint === races[0]!.fingerprint));
    assert.deepEqual(await store.names(), ["race"]);
    const other = await createReleaseMilestone(sql, "tie", { ...initial, capturedAt: "2026-10-04T00:00:00Z" });
    assert.throws(() => resolveTrackerReleaseHistory([good, good], []), refusal("milestone_invalid"));
    const state = resolveTrackerReleaseHistory([good, other], []);
    assert.equal(state.items.length, 1);
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
    rmSync(join(store.directory, "broken.json"));
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
    await runCreate({ id: "pm-early", title: "Real tracker delivery", description: "PRIVATE DESCRIPTION", type: "Task", status: "closed", closeReason: "Delivered", createMode: "progressive" }, { path: pmRoot });
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
    for (const key of ["all-release-tags", "since-previous-tag", "until-release-tag", "release-version-from-package", "release-version", "date", "date-fallback", "date-from-version", "since", "until", "dependency-updates", "respect-item-release"]) {
      const camel = key.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase());
      for (const spelling of new Set([key, camel])) {
        await assert.rejects(runRegisteredCommandForTest(activation.commands, { command: "changelog generate", pmRoot, options: { milestones: true, [spelling]: true } }), refusal("milestone_options"));
      }
    }
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
    const hostConflict = spawnSync(process.execPath, [host, "--path", pmRoot, "changelog", "generate", "--milestones", "--all-release-tags", "--stdout", "--json"], { cwd: root, env, encoding: "utf8" });
    assert.notEqual(hostConflict.status, 0);
    assert.match(hostConflict.stderr + hostConflict.stdout, /milestones cannot be combined/);
    const generated = spawnSync(process.execPath, [cli, "--milestones", "--pm-root", pmRoot, "--stdout"], { cwd: root, env, encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(generated.stdout, /Real tracker delivery/);
    const compact = spawnSync(process.execPath, [cli, "--milestones", "--pm-root", pmRoot, "--summary", "--format", "json"], { cwd: root, env, encoding: "utf8" });
    assert.equal(compact.status, 0, compact.stderr);
    assert.equal(JSON.parse(compact.stdout).item_count, 1);
    const refused = spawnSync(process.execPath, [cli, "--milestones", "--pm-root", pmRoot, "--all-release-tags"], { cwd: root, env, encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /milestones cannot be combined/);
    const captured = await readTrackerReleaseSnapshot(pmRoot);
    assert.equal(captured.items.length, 1);
    assert.equal(captured.items[0]!.description, undefined);
    assert.equal(captured.items[0]!.body, undefined);
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
    for (const args of [["--pm-bin", "custom-pm"], ["--pm-arg=--no-extensions"], ["--body-preview", "40"]]) {
      await assert.rejects(cliTestSurface.main(["--milestones", "--pm-root", pmRoot, ...args]), refusal("milestone_options"));
    }
    await assert.rejects(cliTestSurface.main(["--milestones", "--pm-bin", ""]), /--pm-bin requires a value/);
    for (const spelling of ["body-preview", "bodyPreview"]) {
      await assert.rejects(runRegisteredCommandForTest(activation.commands, { command: "changelog generate", pmRoot, options: { milestones: true, [spelling]: "40" } }), refusal("milestone_options"));
    }
    const error = JSON.parse(cliTestSurface.errorMessage(new ReleaseMilestoneError("milestone_missing", "Missing", "Create a milestone")));
    assert.equal(error.error.code, "milestone_missing");
    assert.equal(error.error.remedy, "Create a milestone");
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
    rmSync(root, { recursive: true, force: true });
  }
});

test("milestone JSON counts use frozen non-change closures across CLI and extension projections", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pm-release-counts-"));
  const pmRoot = join(root, ".agents", "pm");
  try {
    await runInit("pm", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
    await runCreate({ id: "pm-reopened", title: "Live reopened item", type: "Issue", status: "open", createMode: "progressive" }, { path: pmRoot });
    await createReleaseMilestone(new DirectoryReleaseMilestoneStore(pmRoot), "counts", {
      capturedAt: initial.capturedAt,
      items: ["pm-deleted", "pm-reopened"].map((id) => ({ id, title: "Frozen non-change closure", type: "Issue", status: "closed", close_reason: "Not planned" })),
    });
    const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] });
    const writes: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
    for (const mode of ["--summary", "--suggest-semver"]) {
      for (const explain of [false, true]) {
        writes.length = 0;
        await cliTestSurface.main(["--milestones", "--pm-root", pmRoot, mode, "--format", "json", ...(explain ? ["--explain"] : [])]);
        assert.equal(JSON.parse(writes.join("")).excluded_non_change_count, 2, `CLI ${mode}, explain=${explain}`);
        const result = await runRegisteredCommandForTest(activation.commands, {
          command: "changelog generate", pmRoot,
          options: { milestones: true, [mode.slice(2)]: true, format: "json", "explain-selection": explain },
        });
        assert.equal(JSON.parse((result.result as { output: string }).output).excluded_non_change_count, 2, `extension ${mode}, explain=${explain}`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("milestone documentation describes explicit tag refusal outside Git", () => {
  const readme = readFileSync(resolve("README.md"), "utf8");
  assert.match(readme, /Outside a Git\s+repository, explicit tag options \(`--all-release-tags`, `--since-previous-tag`,\s+and `--until-release-tag`\) now fail with `MissingTagHistoryError`/);
});


test("non-git tag refusals expose no executable recovery commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-release-recovery-"));
  const originalPath = process.env.PATH;
  const originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
  try {
    await runInit("pm", { path: join(root, ".agents", "pm") }, { defaults: true, agentGuidance: "skip" });
    process.env.GIT_CEILING_DIRECTORIES = dirname(root);
    for (const path of [originalPath ?? "", ""]) {
      process.env.PATH = path;
      for (const requiredBy of [["--all-release-tags"], ["--since-previous-tag"], ["--until-release-tag"]]) {
        assert.throws(() => assertReleaseTagHistory({ cwd: root, requiredBy }), (error: unknown) => {
          assert.ok(error instanceof MissingTagHistoryError);
          assert.equal(error.code, "E_MISSING_TAG_HISTORY");
          assert.deepEqual(error.recoveryCommands, []);
          assert.match(error.message, /Tracker-only generation and --milestones still work without git/);
          return true;
        });
      }
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
    rmSync(root, { recursive: true, force: true });
  }
});


test("dubious Git ownership preserves its specific trust recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-release-trust-"));
  const keys = ["GIT_TEST_ASSUME_DIFFERENT_OWNER", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT"];
  const saved = keys.map((key) => process.env[key]);
  try {
    initGitFixture(root);
    Object.assign(process.env, { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GIT_CONFIG_GLOBAL: join(root, "empty-config"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" });
    assert.throws(() => assertReleaseTagHistory({ cwd: root, requiredBy: ["--all-release-tags"] }), (error: unknown) => {
      assert.ok(error instanceof MissingTagHistoryError);
      assert.match(error.message, /dubious ownership/);
      assert.match(error.message, /Verify the repository ownership/);
      assert.equal(error.recoveryCommands.length, 1);
      assert.match(error.recoveryCommands[0]!, /^git config --global --add safe.directory '/);
      return true;
    });
  } finally {
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    rmSync(root, { recursive: true, force: true });
  }
});


test("directory publication serializes clock checks and refuses held locks", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pm-release-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new SqlStore();
  let first: ReleaseMilestone;
  let next: ReleaseMilestone;
  try {
    first = await createReleaseMilestone(source, "first", initial);
    next = await createReleaseMilestone(source, "next", { ...initial, capturedAt: "2026-10-02T00:00:00Z" });
  } finally { source.db.close(); }
  const store = new DirectoryReleaseMilestoneStore(root);
  assert.equal(await store.publish(first.name, first), true);
  assert.equal(await store.publish(first.name, first), false);
  await assert.rejects(store.publish("older", { ...first, name: "older" }), refusal("milestone_invalid"));
  mkdirSync(join(store.directory, ".writer-lock"));
  await assert.rejects(store.publish(next.name, next), refusal("milestone_storage"));
  assert.equal(await store.read(next.name), undefined);
  rmSync(join(store.directory, ".writer-lock"), { recursive: true });
  assert.equal(await store.publish(next.name, next), true);
});


test("generated changelog declares the explicit tag-option compatibility change", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-release-notice-"));
  try {
    const output = join(root, "CHANGELOG.md");
    const generated = spawnSync(process.execPath, [resolve("scripts/project-changelog.ts"), "--output", output], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(readFileSync(output, "utf8"), /Compatibility: explicit tag options[^\n]+MissingTagHistoryError[^\n]+source archives and container contexts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("compact snapshots preserve rendering and classification without unrelated content", async () => {
  const sql = new SqlStore();
  try {
    const row: PmItem = { id: "rendered", title: "Parser feature", type: "Issue", status: "closed", close_reason: "Fixed parsing", actual_result: "Delivered PR #12", resolution: "Fixed parser", priority: 1, tags: ["shipping"], author: "fixture-agent", url: "https://example.com/feature", breaking: true,
      body: "PRIVATE BODY", description: "PRIVATE DESCRIPTION", metadata: { breaking: true, release: "r1", milestone: "m1", internal: "PRIVATE METADATA" },
      files: [null, false, 7, "ignored", {}, { path: 2 }, { path: "src/parser.ts", note: "PRIVATE FILE" }],
      tests: [null, {}, { command: "node --test test/parser.test.ts", path: "test/parser.test.ts", note: "PRIVATE TEST" }],
      links: [false, {}, "merged PR #12", { state: "merged", relation: "delivered", url: "https://github.com/example/project/pull/12", note: "PRIVATE LINK" }],
    };
    const saved = await createReleaseMilestone(sql, "rendered", { ...initial, items: [row] });
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE/);
    const options = { includeMetadata: true, includeLinks: true, breakingChanges: true, contributors: true, entryFrom: "close_reason" as const };
    assert.equal(createChangelog({ ...options, items: [...saved.items] }).markdown, createChangelog({ ...options, items: [row] }).markdown);
    const minimal = { ...row, metadata: { private_note: "PRIVATE" }, files: {}, tests: {}, links: {} };
    const later = await createReleaseMilestone(sql, "minimal", { capturedAt: "2026-10-02T00:00:00Z", items: [minimal] });
    assert.equal(later.items[0]!.metadata, undefined);
    assert.equal(later.items[0]!.files, undefined);
  } finally { sql.db.close(); }
});

test("publication lock reports non-contention filesystem failures", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pm-release-lock-fault-"));
  const sql = new SqlStore();
  const realMkdir = fsPromises.mkdir;
  try {
    const milestone = await createReleaseMilestone(sql, "valid", initial);
    t.mock.method(fsPromises, "mkdir", async (...args: Parameters<typeof fsPromises.mkdir>) => {
      if (String(args[0]).endsWith(".writer-lock")) throw Object.assign(new Error("injected lock denial"), { code: "EACCES" });
      return realMkdir(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(new DirectoryReleaseMilestoneStore(root).publish("valid", milestone), refusal("milestone_storage"));
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); sql.db.close(); rmSync(root, { recursive: true, force: true });
  }
});


test("a concurrent same-name publication remains an idempotent retry", async () => {
  const source = new SqlStore();
  let expected: ReleaseMilestone;
  try { expected = await createReleaseMilestone(source, "concurrent", initial); }
  finally { source.db.close(); }
  /** Model a real second SQL writer committing between read and enumeration. */
  class InterleavedSqlStore extends SqlStore {
    override async names(): Promise<string[]> {
      this.db.prepare("INSERT OR IGNORE INTO milestones VALUES (?, ?)").run(expected.name, JSON.stringify(expected));
      return super.names();
    }
  }
  const concurrent = new InterleavedSqlStore();
  try {
    await assert.doesNotReject(async () => {
      assert.deepEqual(await createReleaseMilestone(concurrent, "concurrent", initial), expected);
    });
    assert.deepEqual(await readReleaseMilestones(concurrent), [expected]);
  } finally { concurrent.db.close(); }
});
