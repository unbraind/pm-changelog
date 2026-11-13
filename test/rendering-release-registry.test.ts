import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { listAllComplete, readSettings, resolveRuntimeStatusRegistry, runCreate, runInit, runUpdate, schemaAddStatus, schemaRemapStatus } from "@unbrained/pm-cli/sdk";
import { attributeRenderingRelease } from "../scripts/attribute-rendering-release.ts";
import { resolveRenderingReleaseBoundary } from "../scripts/rendering-release-boundary.ts";
import { isDoneStatus } from "../src/closure-policy.ts";
import { fixtureEnvironment, initGitFixture } from "./git-fixture.ts";

/** Native tracker and real publication commits with isolated Git identity. */
async function registryFixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pm-frozen-registry-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  initGitFixture(cwd, ["-b", "main"]);
  const pmRoot = join(cwd, ".agents/pm");
  await runInit("release", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "2.0.0" }));
  /** Commit exactly the fixture's package and tracker at the publication second. */
  const commit = () => {
    const options = { cwd, env: { ...fixtureEnvironment(), GIT_AUTHOR_DATE: "2026-11-03T00:00:00Z", GIT_COMMITTER_DATE: "2026-11-03T00:00:00Z" }, encoding: "utf8" as const, stdio: "pipe" as const };
    execFileSync("git", ["add", "package.json", ".agents"], options);
    execFileSync("git", ["-c", "user.name=SteveBot", "-c", "user.email=1153461+unbraind@users.noreply.github.com", "commit", "--allow-empty", "-m", "Capture publication registry"], options);
    return execFileSync("git", ["rev-parse", "HEAD"], options).trim();
  };
  /** Create completed metadata through the supported native writer. */
  const create = async (id: string, status: string, closeReason = "Implemented", type = "Task") => {
    // The pinned SDK accepts completedAt on built-in create statuses; its
    // supported update path then applies custom registry status tokens.
    await runCreate({ id, title: id, type, status: "closed", closeReason, tags: "rendering-change", completedAt: "2026-11-02T00:00:00Z", createMode: "progressive" }, { path: pmRoot });
    if (status !== "closed") await runUpdate(id, { status }, { path: pmRoot });
  };
  /** Attribute with the proved published object, retaining refusal diagnostics. */
  const attribute = (published: string, log: (id: string, reason: string) => void = () => {}) => attributeRenderingRelease(pmRoot, "2.0.0", { cwd, preparedFrom: published, publication: { state: "published", gitHead: published }, log });
  return { cwd, pmRoot, commit, create, attribute };
}

test("frozen registry refuses demote-publish-promote but allows a status done in both registries", async (t) => {
  const f = await registryFixture(t);
  await schemaAddStatus("mutable_done", { role: ["terminal", "terminal_done"] }, { pmRoot: f.pmRoot });
  await f.create("release-demoted", "mutable_done");
  await f.create("release-implemented", "closed");
  await schemaAddStatus("mutable_done", { role: ["active"] }, { pmRoot: f.pmRoot });
  const published = f.commit();
  await schemaAddStatus("mutable_done", { role: ["terminal", "terminal_done"] }, { pmRoot: f.pmRoot });
  const boundary = await resolveRenderingReleaseBoundary(f.cwd, f.pmRoot, "2.0.0", published, { state: "published", gitHead: published });
  assert.ok(boundary);
  const frozen = boundary.items.get("release-demoted")!;
  assert.ok(frozen.completed_at, "the nonterminal snapshot retains the earlier completion timestamp");
  assert.equal(isDoneStatus(frozen, boundary.context), false);
  assert.equal(isDoneStatus(frozen, { statusRegistry: resolveRuntimeStatusRegistry((await readSettings(f.pmRoot)).schema) }), true);
  const before = readFileSync(join(f.pmRoot, "history/release-demoted.jsonl"), "utf8");
  const skipped: string[] = [];
  assert.deepEqual(await f.attribute(published, (id) => { skipped.push(id); }), ["release-implemented"]);
  assert.deepEqual(skipped, ["release-demoted"]);
  const rows = (await listAllComplete({}, { pmRoot: f.pmRoot })).items;
  assert.equal(rows.find((row) => row.id === "release-demoted")!.release, undefined);
  assert.equal(rows.find((row) => row.id === "release-implemented")!.release, "2.0.0");
  assert.equal(readFileSync(join(f.pmRoot, "history/release-demoted.jsonl"), "utf8"), before);
});

test("frozen registry allows a completed status renamed after publication without reinterpreting closures", async (t) => {
  const f = await registryFixture(t);
  await schemaAddStatus("shipped_old", { role: ["terminal", "terminal_done"] }, { pmRoot: f.pmRoot });
  await f.create("release-renamed", "shipped_old");
  await f.create("release-nonchange", "shipped_old", "Duplicate of release-renamed");
  await f.create("release-neutral", "shipped_old", "Closed on GitHub as completed on 2026-11-02", "Issue");
  const published = f.commit();
  await schemaRemapStatus("shipped_old", "shipped_new", {}, { pmRoot: f.pmRoot });
  await runUpdate("release-nonchange", { closeReason: "Implemented" }, { path: f.pmRoot });
  await runUpdate("release-neutral", { closeReason: "Fixed and tested" }, { path: f.pmRoot });
  const current = resolveRuntimeStatusRegistry((await readSettings(f.pmRoot)).schema);
  assert.ok(!current.terminal_done_statuses.has("shipped_old"));
  const boundary = await resolveRenderingReleaseBoundary(f.cwd, f.pmRoot, "2.0.0", published, { state: "published", gitHead: published });
  assert.ok(boundary);
  assert.ok(isDoneStatus(boundary.items.get("release-renamed")!, boundary.context));
  const skipped: string[] = [];
  assert.deepEqual(await f.attribute(published, (id) => { skipped.push(id); }), ["release-renamed"]);
  assert.deepEqual(skipped.sort(), ["release-neutral", "release-nonchange"]);
  const rows = (await listAllComplete({}, { pmRoot: f.pmRoot })).items;
  assert.equal(rows.find((row) => row.id === "release-renamed")!.release, "2.0.0");
  assert.ok(rows.filter((row) => row.id !== "release-renamed").every((row) => row.release === undefined));
});

test("unreadable frozen settings or schema refuses before writes; a readable snapshot allows attribution", async (t) => {
  for (const document of ["schema/statuses.json", "schema/types.json", "schema/fields.json", "schema/workflows.json", "settings.json"]) {
    for (const corruption of ["missing", "malformed", "invalid-shape"] as const) {
      const f = await registryFixture(t);
      await f.create("release-schema", "closed");
      const path = join(f.pmRoot, document), good = readFileSync(path, "utf8");
      if (corruption === "missing") rmSync(path);
      else writeFileSync(path, corruption === "malformed" ? "{" : '"invalid schema"');
      const published = f.commit();
      writeFileSync(path, good);
      const item = join(f.pmRoot, "tasks/release-schema.toon"), history = join(f.pmRoot, "history/release-schema.jsonl");
      const before = [item, history].map((path) => readFileSync(path, "utf8"));
      const logged: string[] = [];
      await assert.rejects(f.attribute(published, (id, reason) => { logged.push(`${id}:${reason}`); }), /release_snapshot_unavailable/, `${document}: ${corruption}`);
      assert.deepEqual(logged, ["release-schema:release_snapshot_unavailable"]);
      assert.deepEqual([item, history].map((path) => readFileSync(path, "utf8")), before, "refusal must precede every item/history write");
      const readable = f.commit();
      assert.deepEqual(await f.attribute(readable), ["release-schema"]);
    }
  }
});

test("captured schema paths may be repository relative and never escape into the live filesystem", async (t) => {
  for (const escape of [false, true]) {
    const f = await registryFixture(t);
    await schemaAddStatus("custom_shipped", { role: ["terminal", "terminal_done"] }, { pmRoot: f.pmRoot });
    await f.create("release-custom", "custom_shipped");
    const settingsPath = join(f.pmRoot, "settings.json"), settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const destination = join(f.cwd, ".agents/shared/statuses.json");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(join(f.pmRoot, "schema/statuses.json")));
    settings.schema.files.statuses = escape ? join(f.pmRoot, "schema/statuses.json") : "../shared/statuses.json";
    writeFileSync(settingsPath, JSON.stringify(settings));
    const published = f.commit();
    if (escape) await assert.rejects(f.attribute(published), /release_snapshot_unavailable/);
    else assert.deepEqual(await f.attribute(published), ["release-custom"]);
  }
});
