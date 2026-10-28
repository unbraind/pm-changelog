/** Validate public tracker data on an immutable source copy and a disposable writable overlay. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PmClient, normalizeStatusInput, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { appendReleaseCorrection, createChangelog, createReleaseMilestone, DirectoryReleaseMilestoneStore, readReleaseMilestones, readTrackerReleaseSnapshot, resolveTrackerReleaseHistory } from "../src/index.ts";
import { visibleChangelogItems } from "../src/generator.ts";

/** Hash complete file bytes in stable relative-path order, including native history. */
function treeHash(root: string): string {
  const hash = createHash("sha256");
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) { hash.update(path); hash.update(readFileSync(join(root, path))); }
      else throw new Error("Public source copy must contain regular files only");
    }
  };
  walk(""); return hash.digest("hex");
}

const source = resolve(process.argv[2]);
const sourceBefore = treeHash(source);
const snapshot = await readTrackerReleaseSnapshot(source);
assert.equal(treeHash(source), sourceBefore, "Source reads must preserve every byte");
const roles = resolveRuntimeStatusRegistry((await readSettings(source)).schema);
const done = snapshot.items.filter((item) => roles.terminal_done_statuses.has(normalizeStatusInput(item.status, roles) ?? ""));
assert.ok(done.length);
const temporary = mkdtempSync(join(tmpdir(), "pm-correction-public-"));
try {
  const root = join(temporary, ".agents/pm");
  cpSync(source, root, { recursive: true });
  const writable = (directory: string): void => { chmodSync(directory, 0o700); for (const entry of readdirSync(directory, { withFileTypes: true })) { const target = join(directory, entry.name); if (entry.isDirectory()) writable(target); else chmodSync(target, 0o600); } };
  writable(root);
  const client = new PmClient({ pmRoot: root, author: "public-validation" });
  const store = new DirectoryReleaseMilestoneStore(root);
  const milestone = await createReleaseMilestone(store, "public-baseline", snapshot);
  const published = visibleChangelogItems(resolveTrackerReleaseHistory([milestone], [], roles));
  assert.ok(published.length);
  const claim = published[0].id!;
  const nativeBefore = await client.get(claim, { full: true });
  const history = async (): Promise<string> => createChangelog(resolveTrackerReleaseHistory(await readReleaseMilestones(store), (await readTrackerReleaseSnapshot(root)).items, roles)).markdown;
  const before = await history();
  const request = { schema: 1, release: milestone.name, item: claim, milestone: milestone.fingerprint, id: "validation-1", supersedes: "", expectedRevision: milestone.fingerprint,
    wording: "Public validation correction: this assertion is limited to the measured release evidence.", evidence: ["docs/release-corrections.md"] };
  const first = await appendReleaseCorrection(root, request, { author: "public-validation" });
  const replay = await appendReleaseCorrection(root, request, { author: "public-validation" });
  const second = await appendReleaseCorrection(root, { ...request, id: "validation-2", supersedes: request.id, expectedRevision: first.correction.revision, wording: "Public validation follow-up: retain both factual assertions and their evidence." });
  const nativeAfter = await client.get(claim, { full: true });
  for (const [key, value] of Object.entries(nativeBefore.item)) if (!["notes", "notes_count", "updated_at", "collection_counts"].includes(key)) assert.deepEqual(nativeAfter.item[key], value, `Native field ${key}`);
  if (nativeBefore.item.notes_count !== undefined) assert.equal(nativeAfter.item.notes_count, nativeBefore.item.notes_count + 2);
  const after = await history(); assert.equal(after, before);
  assert.equal(treeHash(source), sourceBefore);
  console.log(JSON.stringify({ source: "public origin/main tracker", items: snapshot.items.length, done_role_items: done.length,
    milestone_items: milestone.items.length, original_bytes: Buffer.byteLength(before), historical_sha256: createHash("sha256").update(before).digest("hex"),
    corrections_created: Number(first.changed) + Number(second.changed), replay_created: Number(replay.changed), chain_length: second.view.chain.length,
    unchanged_source: true, unchanged_native_fields: Object.keys(nativeBefore.item).filter((key) => !["notes", "notes_count", "updated_at", "collection_counts"].includes(key)).length, non_git: true }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
