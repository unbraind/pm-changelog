import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readPublicationState } from "../scripts/rendering-release-boundary.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { listAllComplete, runCreate, runInit, schemaAddField } from "@unbrained/pm-cli/sdk";
import { attributeRenderingRelease } from "../scripts/attribute-rendering-release.ts";
import { createChangelog } from "../src/generator.ts";
import { fixtureEnvironment, initGitFixture } from "./git-fixture.ts";
import { buildConsumerUpgrades } from "../src/consumer-upgrades.ts";

test("selected release attributes only delivered pending rendering actions with native history", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-rendering-release-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const pmRoot = join(cwd, ".agents/pm");
  await runInit("release", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  await schemaAddField("change_facets", { type: "array" }, { pmRoot });
  initGitFixture(cwd);
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "2.0.0" }));
  execFileSync("git", ["add", "package.json"], { cwd, env: fixtureEnvironment() });
  execFileSync("git", ["-c", "user.name=SteveBot", "-c", "user.email=1153461+unbraind@users.noreply.github.com", "commit", "-m", "Unpublished draft version"], { cwd, env: fixtureEnvironment(), stdio: "pipe" });
  for (const [id, status, release, tags] of [["release-pending", "closed", undefined, "rendering-change"], ["release-active", "in_progress", undefined, "rendering-change"], ["release-existing", "closed", "1.0.0", "rendering-change"], ["release-untagged", "closed", undefined, ""]]) {
    await runCreate({ id, status, release, tags, title: `Delivered ${id}`, type: "Task", createMode: "progressive", ...{ changeFacets: JSON.stringify([{ audience: "operator", text: "Regenerate once", breaking: true, upgrade_actions: [{ id: "regenerate-once", title: "Regenerate once", requires: [] }] }]) }, completedAt: status === "closed" ? "2026-11-01T00:00:00Z" : undefined, closeReason: status === "closed" ? "Implemented the change" : undefined }, { path: pmRoot });
  }
  execFileSync("git", ["add", "package.json", ".agents/pm"], { cwd, env: fixtureEnvironment() });
  execFileSync("git", ["-c", "user.name=SteveBot", "-c", "user.email=1153461+unbraind@users.noreply.github.com", "commit", "-m", "Prepare pending window"], { cwd, env: fixtureEnvironment(), stdio: "pipe" });
  const preparedFrom = execFileSync("git", ["rev-parse", "HEAD"], { cwd, env: fixtureEnvironment(), encoding: "utf8" }).trim();
  const options = { cwd, preparedFrom, publication: { state: "unpublished" as const } };
  const history = join(pmRoot, "history/release-pending.jsonl");
  const before = readFileSync(history);
  await assert.rejects(() => attributeRenderingRelease(pmRoot, ""), /selected stable delivery version/);
  assert.deepEqual(await attributeRenderingRelease(pmRoot, "2.0.0", options), ["release-pending"]);
  const after = readFileSync(history);
  assert.ok(after.subarray(0, before.length).equals(before));
  assert.ok(after.length > before.length);
  assert.deepEqual(await attributeRenderingRelease(pmRoot, "2.0.0", options), []);
  assert.deepEqual(readFileSync(history), after);
  const rows = (await listAllComplete({}, { pmRoot })).items;
  assert.equal(rows.find((item) => item.id === "release-pending")!.release, "2.0.0");
  assert.ok(Array.isArray(rows.find((item) => item.id === "release-pending")!.change_facets));
  assert.equal(rows.find((item) => item.id === "release-active")!.release, undefined);
  const workflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /node scripts\/attribute-rendering-release\.ts "\$\{NPM_VERSION\}"/);
  assert.ok(workflow.includes('node scripts/attribute-rendering-release.ts "${NPM_VERSION}" "${RELEASE_BASE_SHA}"'));
  assert.ok(workflow.includes("RELEASE_BASE_SHA: ${{ steps.decide.outputs.base_sha }}"));
  assert.match(workflow, /git add[^\n]+CHANGELOG\.md \.agents\/pm/);
});

test("blank legacy releases remain unpublished in real tracker projections with metadata fallback", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-blank-release-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const pmRoot = join(cwd, ".agents/pm");
  await runInit("release", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  await runCreate({ id: "release-item", title: "Delivered release change", type: "Task", status: "closed", closeReason: "Implemented change", createMode: "progressive" }, { path: pmRoot });
  const item = (await listAllComplete({}, { pmRoot })).items[0]!;
  const change_facets = [{ audience: "operator" as const, text: "Regenerate once", breaking: true as const, upgrade_actions: [{ id: "regenerate", title: "Regenerate once", requires: [] }] }];
  for (const release of [undefined, "", " ", "\t\r\n", "\u2003"]) {
    assert.doesNotThrow(() => {
      const report = buildConsumerUpgrades({ audience: "operator", from: "1.0.0", to: "2.0.0", items: [{ ...item, release, change_facets }] });
      assert.equal(report.action_count, 0);
    });
    const fallback = buildConsumerUpgrades({ audience: "operator", from: "1.0.0", to: "2.0.0", items: [{ ...item, release, metadata: { release: " 2.0.0 " }, change_facets }] });
    assert.equal(fallback.action_count, 1);
  }
});


test("published recovery freezes the prepared item set and published section after later closures", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-published-recovery-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  initGitFixture(cwd);
  const pmRoot = join(cwd, ".agents/pm");
  await runInit("release", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  await runCreate({ id: "release-original", title: "Delivered original change", type: "Task", status: "closed", release: "2.0.0", tags: "rendering-change", completedAt: "2026-11-01T00:00:00Z", closeReason: "Implemented original", createMode: "progressive" }, { path: pmRoot });
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "2.0.0" }));
  /** Commit native fixture state with explicit release preparation dates. */
  const commit = (date: string): string => {
    const env = { ...fixtureEnvironment(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    execFileSync("git", ["add", "package.json", ".agents/pm"], { cwd, env });
    execFileSync("git", ["-c", "user.name=SteveBot", "-c", "user.email=1153461+unbraind@users.noreply.github.com", "commit", "-m", "Release fixture state"], { cwd, env, stdio: "pipe" });
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, env, encoding: "utf8" }).trim();
  };
  const prepared = commit("2026-11-02T00:00:00Z");
  const before = createChangelog({ items: (await listAllComplete({}, { pmRoot })).items, groupBy: "release" }).markdown;
  for (const [id, completedAt] of [["release-later", "2026-11-03T00:00:00Z"], ["release-backdated", "2026-11-01T00:00:00Z"]]) {
    await runCreate({ id, title: `Delivered ${id}`, type: "Task", status: "closed", tags: "rendering-change", completedAt, closeReason: "Implemented later change", createMode: "progressive" }, { path: pmRoot });
  }
  const recovery = commit("2026-11-04T00:00:00Z"), skipped: string[] = [];
  assert.deepEqual(await attributeRenderingRelease(pmRoot, "2.0.0", { cwd, preparedFrom: recovery, publication: { state: "published", gitHead: prepared }, log: (id) => { skipped.push(id); } }), []);
  const rows = (await listAllComplete({}, { pmRoot })).items;
  for (const id of ["release-later", "release-backdated"]) {
    assert.equal(rows.find((item) => item.id === id)!.release, undefined);
    assert.ok(skipped.includes(id));
  }
  const after = createChangelog({ items: rows, groupBy: "release" }).markdown;
  assert.equal(after.slice(after.indexOf("## 2.0.0")), before.slice(before.indexOf("## 2.0.0")));
  assert.match(after, /## Unreleased/);
});


test("unproved release boundary in a non-git tracker logs candidates without stamping", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-unproved-window-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const pmRoot = join(cwd, ".agents/pm"), skipped: string[] = [];
  await runInit("release", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  await runCreate({ id: "release-unknown", title: "Delivered unknown change", type: "Task", status: "closed", tags: "rendering-change", completedAt: "2026-11-01T00:00:00Z", closeReason: "Implemented", createMode: "progressive" }, { path: pmRoot });
  assert.deepEqual(await attributeRenderingRelease(pmRoot, "2.0.0", { cwd, preparedFrom: "HEAD", publication: { state: "unknown" }, log: (id) => { skipped.push(id); } }), []);
  assert.deepEqual(skipped, ["release-unknown"]);
  assert.equal((await listAllComplete({}, { pmRoot })).items[0].release, undefined);
  initGitFixture(cwd);
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  execFileSync("git", ["add", "package.json", ".agents/pm"], { cwd, env: fixtureEnvironment() });
  execFileSync("git", ["-c", "user.name=SteveBot", "-c", "user.email=1153461+unbraind@users.noreply.github.com", "commit", "-m", "Unknown publication fixture"], { cwd, env: fixtureEnvironment(), stdio: "pipe" });
  skipped.length = 0;
  assert.deepEqual(await attributeRenderingRelease(pmRoot, "2.0.0", { cwd, preparedFrom: "HEAD", publication: { state: "unknown" }, log: (id) => { skipped.push(id); } }), []);
  assert.deepEqual(skipped, ["release-unknown"]);
  assert.equal((await listAllComplete({}, { pmRoot })).items[0].release, undefined);

});



test("registry publication proof canonicalizes versions and never treats server errors as absence", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/fixture/2.0.0") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ version: "2.0.0", gitHead: "a".repeat(40) })); }
    else if (request.url === "/fixture/3.0.0") { response.writeHead(404); response.end(); }
    else { response.writeHead(503); response.end(); }
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const registry = `http://127.0.0.1:${address.port}`;
  assert.deepEqual(await readPublicationState("fixture", "v2.0.0", registry), { state: "published", gitHead: "a".repeat(40) });
  assert.deepEqual(await readPublicationState("fixture", "3.0.0", registry), { state: "unpublished" });
  assert.deepEqual(await readPublicationState("fixture", "4.0.0", registry), { state: "unknown" });
  assert.deepEqual(await readPublicationState("fixture", "invalid", registry), { state: "unknown" });
});
