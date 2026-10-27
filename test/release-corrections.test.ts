import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { decode } from "@toon-format/toon";
import { PmClient, WorkspaceTransactionInterruptedError, runInit, runCreate, schemaAddStatus } from "@unbrained/pm-cli/sdk";
import type { WorkspaceTransactionTransition } from "@unbrained/pm-cli/sdk";
import { appendReleaseCorrection, createChangelog, createReleaseMilestone, DirectoryReleaseMilestoneStore, formatReleaseCorrection, formatReleaseCorrectionView,
  parseReleaseCorrection, readReleaseCorrectionView, readReleaseMilestones, readTrackerReleaseSnapshot, resolveTrackerReleaseHistory, ReleaseCorrectionError } from "../src/index.ts";
import type { ReleaseCorrectionInput, ReleaseCorrectionView } from "../src/index.ts";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import extension from "../src/extension.ts";
import { releaseCorrectionTestSurface } from "../src/release-corrections.ts";
import { cliTestSurface } from "../src/cli.ts";
import { runReleaseCorrectionsCli, runReleaseCorrectionsCommand } from "../src/release-correction-command.ts";

/** Initialize a real non-git SDK tracker, with a published done-role claim. */
async function fixture(t: { after(fn: () => void): void }, count = 1): Promise<{ cwd: string; root: string; client: PmClient; milestone: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "pm-correction-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, ".agents/pm");
  await runInit("fix", { path: root }, { defaults: true, agentGuidance: "skip" });
  const client = new PmClient({ pmRoot: root, author: "fixture" });
  for (let i = 0; i < count; i++) await runCreate({ id: `fix-claim${i}`, title: `Published claim ${i}`, type: "Feature", status: "closed", closeReason: "Delivered", completedAt: "2026-10-01T00:00:00Z", createMode: "progressive",
    unset: ["parent", "goal", "objective", "sprint", "release"], body: "Native body\r\n  text", tags: "public,fixture", priority: "2" }, { path: root, author: "fixture" });
  const milestone = await createReleaseMilestone(new DirectoryReleaseMilestoneStore(root), "v1", await readTrackerReleaseSnapshot(root));
  return { cwd, root, client, milestone: milestone.fingerprint };
}
/** Build a first correction with exact authored CRLF and surrounding whitespace. */
function input(milestone: string, item = "fix-claim0", id = "c1"): ReleaseCorrectionInput {
  return { schema: 1, release: "v1", item, milestone, id, supersedes: "", expectedRevision: milestone, wording: "  Correct wording\r\nwith evidence\t ", evidence: ["docs/public-proof.md#result", "https://example.com/proof"] };
}
/** Require stable typed refusals and an actionable remedy. */
function refusal(code: string): (error: unknown) => boolean {
  return (error) => { assert.ok(error instanceof ReleaseCorrectionError); assert.equal(error.code, code); assert.ok(error.remedy); return true; };
}

test("append/replay/chain preserve historical bytes and refuse cycles or stale revisions", async (t) => {
  const { root, milestone } = await fixture(t);
  const history = async (): Promise<string> => createChangelog(resolveTrackerReleaseHistory(await readReleaseMilestones(new DirectoryReleaseMilestoneStore(root)), (await readTrackerReleaseSnapshot(root)).items)).markdown;
  const before = await history();
  const first = await appendReleaseCorrection(root, input(milestone));
  assert.equal(first.changed, true);
  assert.equal(first.view.original, "Published claim 0");
  assert.equal(first.view.current, input(milestone).wording);
  assert.equal((await appendReleaseCorrection(root, input(milestone))).changed, false);
  const secondInput = { ...input(milestone, "fix-claim0", "c2"), supersedes: "c1", expectedRevision: first.correction.revision, wording: "Follow-up factual correction" };
  const second = await appendReleaseCorrection(root, secondInput);
  assert.equal(second.view.chain.length, 2);
  const repeatedWording = await appendReleaseCorrection(root, { ...input(milestone, "fix-claim0", "c3"), supersedes: "c2", expectedRevision: second.correction.revision });
  assert.equal(repeatedWording.changed, true);
  assert.equal(repeatedWording.view.chain.length, 3);
  assert.equal((await appendReleaseCorrection(root, input(milestone))).changed, false);
  await assert.rejects(appendReleaseCorrection(root, { ...secondInput, id: "c1", supersedes: "c2", expectedRevision: second.correction.revision }), refusal("correction_cycle"));
  await assert.rejects(appendReleaseCorrection(root, { ...input(milestone), id: "self", supersedes: "self" }), refusal("correction_cycle"));
  await assert.rejects(appendReleaseCorrection(root, { ...input(milestone), wording: "Replacement" }), refusal("correction_conflict"));
  await assert.rejects(appendReleaseCorrection(root, input(milestone, "fix-claim0", "stale")), refusal("correction_stale"));
  await assert.rejects(appendReleaseCorrection(root, { ...input(milestone), milestone: "0".repeat(64) }), refusal("correction_stale"));
  assert.equal(await history(), before);
  assert.deepEqual(decode(formatReleaseCorrectionView(second.view)), second.view);
  assert.deepEqual(JSON.parse(formatReleaseCorrectionView(second.view, "json")), second.view);
  assert.deepEqual(parseReleaseCorrection(decode(formatReleaseCorrection(first.correction))), first.correction);
  assert.equal(JSON.parse(cliTestSurface.errorMessage(new ReleaseCorrectionError("correction_stale", "Read current."))).error.remedy, "Read current.");
});

test("strict producer/validator schema rejects sparse arrays, unknown fields and extreme values", () => {
  const base = input("0".repeat(64));
  const sparse = new Array(2); sparse[1] = "proof";
  const extra = ["proof"]; Object.assign(extra, { hidden: "bad" });
  const bad: unknown[] = [Object.create(base), new Date(), undefined, null, [], 1, { ...base, extra: true }, ...[0, -1, NaN, Infinity, -Infinity, 1e300].map((schema) => ({ ...base, schema })),
    ...[null, undefined, "", [], [""], [1], sparse, extra, Array(17).fill("proof"), ["x".repeat(513)], ["bad\u0000"], ["\ud800"], ["\udc00"], ["bad\u0085"]].map((evidence) => ({ ...base, evidence })),
    ...["", " ", 1, "x".repeat(4001), "bad\u0000", "\ud800", "\udc00", "bad\u0085", "bad\u009b"].map((wording) => ({ ...base, wording })),
    ...["", "../x", 1, "x".repeat(81), "id\n", "id\r\n", "id\u2028"].flatMap((value) => ["release", "item", "id", "supersedes"].map((field) => ({ ...base, [field]: value === "" && field === "supersedes" ? null : value }))),
    ...["", 1, "A".repeat(64), "0".repeat(64) + "\n"].flatMap((value) => ["milestone", "expectedRevision", "revision"].map((field) => ({ ...base, [field]: value })))];
  for (const value of bad) assert.throws(() => parseReleaseCorrection(value), refusal("correction_invalid"));
  const view = { chain: [], skipped: { foreign: Infinity, invalid: 0, unrelated: 0 } } as unknown as ReleaseCorrectionView;
  for (const count of [NaN, Infinity, -Infinity, -1, 1.1, 10001]) assert.throws(() => formatReleaseCorrectionView({ ...view, skipped: { ...view.skipped, foreign: count } }), refusal("correction_invalid"));
});

test("foreign and malformed records fail alone and custom status roles select published claims", async (t) => {
  const { root, client, milestone } = await fixture(t);
  await client.notes("fix-claim0", { add: "Human discussion" });
  await client.notes("fix-claim0", { addJson: JSON.stringify({ type: "pm-changelog.release-correction", correction: "invalid" }) });
  const other = parseReleaseCorrection({ ...input(milestone), release: "other" });
  await client.notes("fix-claim0", { addJson: JSON.stringify({ type: "pm-changelog.release-correction", correction: other }) });
  await appendReleaseCorrection(root, input(milestone));
  await client.notes("fix-claim0", { addJson: JSON.stringify({ type: "pm-changelog.release-correction", correction: parseReleaseCorrection(input(milestone)) }) });
  const view = await readReleaseCorrectionView(root, "v1", "fix-claim0");
  assert.deepEqual(view.skipped, { foreign: 1, invalid: 2, unrelated: 1 });
  await assert.rejects(readReleaseCorrectionView(root, "v1", "fix-missing"), refusal("correction_missing"));
  for (let seed = 1; seed <= 8; seed++) {
    const roles = [["terminal_done", "terminal"], ["terminal_canceled", "terminal"], ["active"], ["blocked"]][seed % 4];
    const status = `${roles.includes("terminal_done") ? "active" : "closed"}_${Math.floor(random(seed * 7919)() * 1000000000)}`;
    await schemaAddStatus(status, { role: roles }, { pmRoot: root });
    await runCreate({ id: `fix-custom${seed}`, title: "Custom published claim", type: "Task", status, closeReason: "Delivered", createMode: "progressive", unset: ["parent", "goal", "objective", "sprint", "release"] }, { path: root, author: "fixture" });
    await createReleaseMilestone(new DirectoryReleaseMilestoneStore(root), `v${seed + 1}`, { ...(await readTrackerReleaseSnapshot(root)), capturedAt: new Date(Date.now() + seed * 1000).toISOString() });
    if (roles.includes("terminal_done")) assert.equal((await readReleaseCorrectionView(root, `v${seed + 1}`, `fix-custom${seed}`)).current, "Custom published claim");
    else await assert.rejects(readReleaseCorrectionView(root, `v${seed + 1}`, `fix-custom${seed}`), refusal("correction_missing"));
  }
});

/** Deterministic random source, shared only by the reference operation scheduler. */
function random(seed: number): () => number {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
}

test("seeded model: 500 random operation sequences preserve SDK-read state, old replays, whitespace and relationships", async (t) => {
  const { root, client, milestone } = await fixture(t, 8);
  const rng = random(0xc011ec7);
  const model = new Map<string, { inputs: ReleaseCorrectionInput[]; revisions: string[]; nativeEvents: unknown[] }>();
  const native = new Map<string, unknown>();
  for (let index = 0; index < 8; index++) {
    const id = `fix-claim${index}`;
    await client.update(id, { dep: [`id=fix-claim${(index + 1) % 8},kind=related`], unset: ["parent", "goal", "objective", "sprint", "release"] });
    native.set(id, (await client.get(id, { fields: "title,body,status,type,priority,tags,parent,goal,objective,sprint,release,dependencies,files,docs,tests" })).item);
    model.set(id, { inputs: [], revisions: [], nativeEvents: [] });
  }
  let operations = 0;
  for (let sequence = 0; sequence < 500; sequence++) {
    const id = `fix-claim${Math.floor(rng() * 8)}`;
    const state = model.get(id)!;
    // Random ambient focus must never become a parent or scope for an annotation.
    await client.focus(`fix-claim${Math.floor(rng() * 8)}`);
    const whitespace = [" ", "\r\n", "\n\t", "  \r\n\t "][Math.floor(rng() * 4)];
    const request: ReleaseCorrectionInput = { ...input(milestone, id, `seq-${sequence}`), supersedes: state.inputs.at(-1)?.id ?? "", expectedRevision: state.revisions.at(-1) ?? milestone,
      wording: `${whitespace}Claim ${sequence} ${Math.floor(rng() * 100000)}${whitespace}`, evidence: [`${whitespace}docs/proof-${sequence}.md${whitespace}`] };
    const actions = ["append", "replay", "stale", "roundtrip"];
    for (let position = actions.length - 1; position > 0; position--) {
      const other = Math.floor(rng() * (position + 1));
      [actions[position], actions[other]] = [actions[other], actions[position]];
    }
    for (const action of actions) {
      if (action === "append") {
        const transport = Math.floor(rng() * 3);
        const imported: unknown = transport === 0 ? request : transport === 1 ? JSON.parse(formatReleaseCorrection(request, "json")) : decode(formatReleaseCorrection(request));
        const result = await appendReleaseCorrection(root, imported);
        assert.equal(result.changed, true);
        state.inputs.push(request); state.revisions.push(result.correction.revision);
      } else if (action === "replay") {
        if (state.inputs.length) {
          const replay = state.inputs[Math.floor(rng() * state.inputs.length)];
          assert.equal((await appendReleaseCorrection(root, JSON.parse(JSON.stringify(replay, null, 2).replace(/\n/g, "\r\n")))).changed, false);
        } else assert.equal((await readReleaseCorrectionView(root, "v1", id)).chain.length, 0);
      } else if (action === "stale") {
        await assert.rejects(appendReleaseCorrection(root, { ...request, id: `stale-${sequence}`, expectedRevision: "0".repeat(64), supersedes: "" }), refusal("correction_stale"));
      } else {
        for (const format of ["json", "toon"] as const) {
          const output = formatReleaseCorrection(request, format);
          const parsed = format === "json" ? JSON.parse(output) : decode(output);
          const { revision: _revision, ...fields } = parseReleaseCorrection(parsed);
          assert.deepEqual(fields, request);
        }
      }
      operations++;
    }
    const sdk = await client.notes(id, { limit: "10001", includeMeta: true, outputBudget: "unbounded", outputLimit: "unbounded" });
    // Reference is the exact authored data, with no duplicate producer or normalization logic.
    assert.ok("notes" in sdk);
    assert.deepEqual(sdk.notes.slice(0, state.nativeEvents.length), state.nativeEvents);
    assert.equal(sdk.notes.length, state.nativeEvents.length + 1);
    for (const event of sdk.notes) {
      assert.equal(event.format, "json"); assert.equal(event.event_type, "pm-changelog.release-correction");
      assert.equal(event.author, "pm-changelog"); assert.ok(Number.isFinite(Date.parse(event.created_at)));
      assert.equal(typeof event.text, "string"); assert.ok(event.text.length > 0);
    }
    state.nativeEvents = structuredClone(sdk.notes);
    const readBack = sdk.notes.map((note) => (note.data as { correction: Record<string, unknown> }).correction);
    assert.deepEqual(readBack.map(({ revision: _revision, ...fields }) => fields), state.inputs);
    assert.deepEqual(readBack.map((row) => row.revision), state.revisions);
    const view = await readReleaseCorrectionView(root, "v1", id);
    assert.equal(view.current, request.wording); assert.equal(view.chain.length, state.inputs.length);
    assert.deepEqual(JSON.parse(formatReleaseCorrectionView(view, "json")), view);
    assert.deepEqual(decode(formatReleaseCorrectionView(view)), view);
    assert.deepEqual((await client.get(id, { fields: "title,body,status,type,priority,tags,parent,goal,objective,sprint,release,dependencies,files,docs,tests" })).item, native.get(id)); operations++;
  }
  t.diagnostic(`seed=0x0c011ec7 sequences=500 operations=${operations} SDK annotations=${[...model.values()].reduce((sum, state) => sum + state.inputs.length, 0)}`);
});

test("competing writers at every commit boundary report one append and truthful peer success", async (t) => {
  const { root, milestone } = await fixture(t, 5);
  const boundaries: WorkspaceTransactionTransition[] = ["prepared", "step_applied", "step_recorded", "committing", "committed"];
  for (const [index, boundary] of boundaries.entries()) {
    const request = input(milestone, `fix-claim${index}`);
    let peer: ReturnType<typeof appendReleaseCorrection> | undefined;
    const owner = await appendReleaseCorrection(root, request, { author: "owner-writer", onTransition(context) {
      if (context.transition === boundary) peer = appendReleaseCorrection(root, request, { author: "peer-writer" });
    } });
    assert.equal(owner.changed, true);
    assert.ok(peer);
    assert.equal((await peer).changed, false);
    assert.equal((await readReleaseCorrectionView(root, "v1", request.item)).chain.length, 1);
  }
});

test("interrupted plans revalidate SDK targets at every boundary; a competing correction wins safely", async (t) => {
  const { root, milestone } = await fixture(t, 5);
  const boundaries: WorkspaceTransactionTransition[] = ["prepared", "step_applied", "step_recorded", "committing", "committed"];
  for (const [index, boundary] of boundaries.entries()) {
    const request = input(milestone, `fix-claim${index}`);
    await assert.rejects(appendReleaseCorrection(root, request, { onTransition(context) { if (context.transition === boundary) throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
    if (boundary === "prepared") {
      await appendReleaseCorrection(root, { ...request, id: "peer", wording: "Peer won" });
      await assert.rejects(appendReleaseCorrection(root, request), refusal("correction_stale"));
      assert.equal((await readReleaseCorrectionView(root, "v1", request.item)).current, "Peer won");
    } else {
      assert.equal((await appendReleaseCorrection(root, request)).changed, false);
      assert.equal((await readReleaseCorrectionView(root, "v1", request.item)).chain.length, 1);
    }
  }
});

test("ordinary transaction failure retains append-only assertions and retries inspect current state", async (t) => {
  const { root, milestone } = await fixture(t);
  await assert.rejects(appendReleaseCorrection(root, input(milestone), { onTransition(context) { if (context.transition === "step_applied") throw new Error("failure"); } }), /failure/);
  assert.equal((await appendReleaseCorrection(root, input(milestone))).changed, false);
});

/** Install the real built extension, retaining the supported package SDK import seam. */
function installExtension(root: string): void {
  const target = join(root, "extensions/pm-changelog");
  mkdirSync(target, { recursive: true });
  cpSync(resolve("dist"), join(target, "dist"), { recursive: true });
  cpSync(resolve("manifest.json"), join(target, "manifest.json"));
  writeFileSync(join(target, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(resolve("node_modules"), join(target, "node_modules"), "junction");
}

test("standalone and host commands match SDK without a git executable, including typed refusals", async (t) => {
  const { cwd, root, milestone } = await fixture(t);
  installExtension(root);
  const noGit = join(cwd, "bin"); mkdirSync(noGit);
  const env = { ...process.env, PATH: noGit, PM_AUTHOR: "fixture", PM_GLOBAL_PATH: join(cwd, "global"), PM_PATH: root, DO_NOT_TRACK: "1", GIT_CEILING_DIRECTORIES: dirname(cwd) };
  const file = join(cwd, "correction.json"); writeFileSync(file, JSON.stringify(input(milestone)));
  const commands = [[resolve("dist/cli.js"), "corrections", "--pm-root", root], [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", root, "changelog", "corrections"]];
  for (const command of commands) {
    const result = spawnSync(process.execPath, [...command, "append", "--input", file, "--json"], { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).correction.wording, input(milestone).wording);
    for (const flags of [[], ["--json"], ["--format", "json"]]) {
      const read = spawnSync(process.execPath, [...command, "view", "--release", "v1", "--item", "fix-claim0", ...flags], { cwd, env, encoding: "utf8" });
      assert.equal(read.status, 0, read.stderr);
      assert.deepEqual(flags.length ? JSON.parse(read.stdout) : decode(read.stdout), await readReleaseCorrectionView(root, "v1", "fix-claim0"));
    }
    const bad = spawnSync(process.execPath, [...command, "view", "--format", "invalid"], { cwd, env, encoding: "utf8" });
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /correction_invalid/);
  }
  assert.ok(JSON.parse(await runReleaseCorrectionsCommand(root, "append", { input: file, format: "json" })).correction);
  assert.ok(decode(await runReleaseCorrectionsCommand(root, "append", { input: file })));
  for (const options of [{ input: join(cwd, "absent") }, { input: cwd }, { input: file, release: "v1" }, { input: file, item: "fix-claim0" }]) await assert.rejects(runReleaseCorrectionsCommand(root, "append", options), refusal("correction_invalid"));
  for (const text of ["{", "x".repeat(131073)]) { writeFileSync(file, text); await assert.rejects(runReleaseCorrectionsCommand(root, "append", { input: file }), refusal("correction_invalid")); }
});

test("SDK structured context events refuse edits and deletion while foreign notes remain independent", async (t) => {
  const { root, client, milestone } = await fixture(t);
  await appendReleaseCorrection(root, input(milestone));
  await assert.rejects(client.notes("fix-claim0", { edit: 1, add: "Replace" }), /append-only|cannot be|immutable/);
  await assert.rejects(client.notes("fix-claim0", { delete: 1 }), /append-only|cannot be|immutable/);
  await client.notes("fix-claim0", { addJson: JSON.stringify({ type: "another-package.event", correction: "foreign" }) });
  assert.equal((await readReleaseCorrectionView(root, "v1", "fix-claim0")).skipped.foreign, 1);
});

test("standalone parser covers actions, JSON switches, help and invalid arity in process", async (t) => {
  const { root, cwd, milestone } = await fixture(t);
  const file = join(cwd, "input.json"); writeFileSync(file, JSON.stringify(input(milestone)));
  const output: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { output.push(String(chunk)); return true; });
  await runReleaseCorrectionsCli(["--help"]); assert.match(output.pop()!, /-h\|--help/);
  await runReleaseCorrectionsCli(["append", "--pm-root", root, "--input", file, "--json"]); assert.equal(JSON.parse(output.pop()!).changed, true);
  await runReleaseCorrectionsCli(["view", "--pm-root", root, "--release", "v1", "--item", "fix-claim0"]); assert.ok(decode(output.pop()!));
  await assert.rejects(runReleaseCorrectionsCli(["--unknown"]), refusal("correction_invalid"));
  for (const args of [[], ["append", "view"]]) await assert.rejects(runReleaseCorrectionsCli(args), refusal("correction_invalid"));
  await assert.rejects(runReleaseCorrectionsCommand(root, "view", { release: "v1", item: "fix-claim0", input: file }), refusal("correction_invalid"));
  await assert.rejects(readReleaseCorrectionView(root, "absent", "fix-claim0"), refusal("correction_missing"));
});

test("pure boundaries reject incomplete SDK receipts, sparse outputs and excessive chains without SDK substitution", async (t) => {
  const { root, milestone } = await fixture(t);
  const { requireCompleteNotes, projectCorrectionNotes, checkTarget } = releaseCorrectionTestSurface;
  for (const result of [{}, { notes: [], has_more: true }, { notes: [], read_output: { strings_compacted: true } }, { notes: [], read_output: { rows_compacted: true } }, { notes: new Array(10001) }]) {
    assert.throws(() => requireCompleteNotes(result), refusal("correction_limit"));
  }
  assert.deepEqual(requireCompleteNotes({ notes: [] }), []);
  const baseline = await readReleaseCorrectionView(root, "v1", "fix-claim0", { milestones: new DirectoryReleaseMilestoneStore(root) });
  assert.throws(() => checkTarget({ ...baseline, skipped: { foreign: 10000, invalid: 0, unrelated: 0 } }, parseReleaseCorrection(input(milestone))), refusal("correction_limit"));
  const owned = (correction: unknown): { created_at: string; author: string; text: string; format: "json"; data: { type: string; correction: unknown } } => ({ created_at: "2026-10-01T00:00:00Z", author: "fixture", text: "event", format: "json", data: { type: "pm-changelog.release-correction", correction } });
  for (const data of [null, 1, [], {}, { type: "foreign" }]) {
    const foreign = { created_at: "2026-10-01T00:00:00Z", author: "fixture", text: "foreign", format: "json" as const, data };
    assert.equal(projectCorrectionNotes(structuredClone(baseline), [foreign] as unknown as Parameters<typeof projectCorrectionNotes>[1]).skipped.foreign, 1);
  }
  for (const fields of [{ item: "another-item" }, { milestone: "1".repeat(64) }, { expectedRevision: "1".repeat(64) }, { supersedes: "unknown" }]) {
    const record = parseReleaseCorrection({ ...input(milestone), ...fields });
    const view = projectCorrectionNotes(structuredClone(baseline), [owned(record)] as unknown as Parameters<typeof projectCorrectionNotes>[1]);
    assert.equal(view.chain.length, 0); assert.equal(view.skipped.invalid + view.skipped.unrelated, 1);
  }
  let view = structuredClone(baseline);
  const notes: ReturnType<typeof owned>[] = [];
  for (let index = 0; index < 257; index++) {
    const correction = parseReleaseCorrection({ ...input(milestone, "fix-claim0", `limit-${index}`), expectedRevision: view.revision, supersedes: view.chain.at(-1)?.id ?? "" });
    const event = owned(correction); notes.push(event);
    if (index < 256) view = projectCorrectionNotes(view, [event] as unknown as Parameters<typeof projectCorrectionNotes>[1]);
  }
  assert.throws(() => projectCorrectionNotes(structuredClone(baseline), notes as unknown as Parameters<typeof projectCorrectionNotes>[1]), refusal("correction_limit"));
  assert.throws(() => checkTarget(view, parseReleaseCorrection({ ...input(milestone, "fix-claim0", "overflow"), supersedes: view.chain.at(-1)!.id, expectedRevision: view.revision })), refusal("correction_limit"));
  assert.throws(() => formatReleaseCorrectionView({ ...baseline, chain: new Array(2) }), refusal("correction_invalid"));
  const disguised = new Array(2); disguised[0] = view.chain[0]; Object.assign(disguised, { extra: view.chain[0] });
  assert.throws(() => formatReleaseCorrectionView({ ...baseline, chain: disguised }), refusal("correction_invalid"));
  assert.throws(() => formatReleaseCorrectionView({ ...baseline, chain: Array(257).fill(view.chain[0]) }), refusal("correction_invalid"));
});

test("committed journal replay refuses an item restored out of band to its pre-correction bytes", async (t) => {
  const { root, milestone } = await fixture(t);
  const path = join(root, "features/fix-claim0.toon");
  const before = readFileSync(path);
  await appendReleaseCorrection(root, input(milestone));
  // Inject foreign storage drift, leaving the journal untouched; assertions read back through the SDK.
  writeFileSync(path, before);
  await assert.rejects(appendReleaseCorrection(root, input(milestone)), refusal("correction_conflict"));
});


test("registered correction handlers use the real SDK tracker and cover missing action refusals", async (t) => {
  const { root, cwd, milestone } = await fixture(t);
  const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] });
  assert.deepEqual(activation.failed, []);
  const file = join(cwd, "input.json"); writeFileSync(file, JSON.stringify(input(milestone)));
  const appended = await runRegisteredCommandForTest(activation.commands, { command: "changelog corrections", pmRoot: root, args: ["append"], options: { input: file }, global: { author: "fixture" } });
  assert.ok(appended.result && typeof appended.result === "object" && "output" in appended.result);
  assert.equal(JSON.parse(String(appended.result.output)).changed, true);
  const viewed = await runRegisteredCommandForTest(activation.commands, { command: "changelog corrections", pmRoot: root, args: ["view"], options: { release: "v1", item: "fix-claim0" }, global: { json: false } });
  assert.ok(viewed.result && typeof viewed.result === "object" && "output" in viewed.result);
  assert.deepEqual(decode(String(viewed.result.output)), await readReleaseCorrectionView(root, "v1", "fix-claim0"));
  await assert.rejects(runRegisteredCommandForTest(activation.commands, { command: "changelog corrections", pmRoot: root }), refusal("correction_invalid"));
});


test("maximum valid Unicode producer output survives real UTF-8 JSON/TOON round trips", () => {
  const record = parseReleaseCorrection({ ...input("0".repeat(64)), wording: "😀".repeat(2000), evidence: Array.from({ length: 16 }, (_, index) => "界".repeat(500) + index) });
  for (const format of ["json", "toon"] as const) {
    const text = Buffer.from(formatReleaseCorrection(record, format), "utf8").toString("utf8");
    assert.deepEqual(parseReleaseCorrection(format === "json" ? JSON.parse(text) : decode(text)), record);
  }
});

test("SDK reader refuses unrenderable original wording before a correction can be written", async (t) => {
  const { root, client } = await fixture(t);
  const snapshot = await readTrackerReleaseSnapshot(root);
  await createReleaseMilestone(new DirectoryReleaseMilestoneStore(root), "bad-title", { capturedAt: new Date(Date.now() + 1000).toISOString(), items: snapshot.items.map((item) => ({ ...item, title: "invalid\ud800" })) });
  await assert.rejects(readReleaseCorrectionView(root, "bad-title", "fix-claim0"), refusal("correction_invalid"));
  assert.equal((await client.notes("fix-claim0")).count, 0);
});
