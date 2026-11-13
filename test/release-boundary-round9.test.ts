import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { listAllComplete, runCreate, runInit, runUpdate, schemaAddField } from "@unbrained/pm-cli/sdk";
import { attributeRenderingRelease } from "../scripts/attribute-rendering-release.ts";
import { canonicalRegenerationOptions } from "../src/check-drift.ts";
import { fixtureEnvironment, initGitFixture } from "./git-fixture.ts";

/** A real tracker whose closed rendering-change items are committed at one explicit whole-second release time. */
async function releaseFixture(t: TestContext, items: readonly [string, string][], facets?: string): Promise<{ cwd: string; pmRoot: string; commit: (date: string) => string; git: (...args: string[]) => string }> {
  const cwd = mkdtempSync(join(tmpdir(), "pm-release-boundary-r9-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  initGitFixture(cwd, ["-b", "main"]);
  const pmRoot = join(cwd, ".agents/pm");
  await runInit("release", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  if (facets) await schemaAddField("change_facets", { type: "array" }, { pmRoot });
  for (const [id, completedAt] of items) await runCreate({ id, title: `Delivered ${id}`, type: "Task", status: "closed", tags: "rendering-change", completedAt, closeReason: "Implemented", createMode: "progressive", ...(facets ? { changeFacets: facets } : {}) }, { path: pmRoot });
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "2.0.0" }));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd, env: fixtureEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (date: string): string => {
    const env = { ...fixtureEnvironment(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    execFileSync("git", ["add", "package.json", ".agents/pm"], { cwd, env });
    execFileSync("git", ["-c", "user.name=SteveBot", "-c", "user.email=1153461+unbraind@users.noreply.github.com", "commit", "--allow-empty", "-m", `Release fixture ${date}`], { cwd, env, stdio: "pipe" });
    return git("rev-parse", "HEAD");
  };
  return { cwd, pmRoot, commit, git };
}

test("a completion inside the release commit's second is attributed; the next second is not", async (t) => {
  const f = await releaseFixture(t, [["release-same-second", "2026-11-03T00:00:00.500Z"], ["release-next-second", "2026-11-03T00:00:01.000Z"]]);
  const published = f.commit("2026-11-03T00:00:00Z"); const skipped: string[] = [];
  assert.deepEqual(await attributeRenderingRelease(f.pmRoot, "2.0.0", { cwd: f.cwd, preparedFrom: published, publication: { state: "published", gitHead: published }, log: (id) => { skipped.push(id); } }), ["release-same-second"]);
  const rows = (await listAllComplete({}, { pmRoot: f.pmRoot })).items;
  assert.equal(rows.find((row) => row.id === "release-same-second")!.release, "2.0.0");
  assert.equal(rows.find((row) => row.id === "release-next-second")!.release, undefined);
  assert.deepEqual(skipped, ["release-next-second"]);
});

test("without gitHead an unprefixed release tag proves the boundary, and disagreeing tags refuse", async (t) => {
  const f = await releaseFixture(t, [["release-tagged", "2026-11-01T00:00:00Z"]]);
  const published = f.commit("2026-11-02T00:00:00Z");
  f.git("tag", "2.0.0", published);
  // A refusal becomes a string, so an unresolved tag fails this assertion instead of throwing.
  const attributed = await attributeRenderingRelease(f.pmRoot, "2.0.0", { cwd: f.cwd, preparedFrom: published, publication: { state: "published" }, log: () => {} }).catch((error: unknown) => String(error));
  assert.deepEqual(attributed, ["release-tagged"]);

  const g = await releaseFixture(t, [["release-ambiguous", "2026-11-01T00:00:00Z"]]);
  const first = g.commit("2026-11-02T00:00:00Z"); const second = g.commit("2026-11-02T00:00:05Z");
  g.git("tag", "v2.0.0", first); g.git("tag", "2.0.0", second);
  const logged: string[] = [];
  await assert.rejects(attributeRenderingRelease(g.pmRoot, "2.0.0", { cwd: g.cwd, preparedFrom: second, publication: { state: "published" }, log: (id, reason) => { logged.push(`${id}:${reason}`); } }), /published_tag_ambiguous/);
  assert.deepEqual(logged, ["release-ambiguous:published_tag_ambiguous"]);
  assert.equal((await listAllComplete({}, { pmRoot: g.pmRoot })).items.find((row) => row.id === "release-ambiguous")!.release, undefined);
});

test("regeneration options keep the plural exclude-tag aliases with the native precedence", () => {
  const flags = [{ long: "--exclude-tag" }, { long: "--output" }];
  for (const key of ["exclude-tags", "excludeTags"]) assert.deepEqual({ ...canonicalRegenerationOptions({ [key]: ["internal", "chore"] }, flags) }, { "exclude-tag": ["internal", "chore"] }, key);
  assert.deepEqual({ ...canonicalRegenerationOptions({ excludeTags: ["alias"], excludeTag: ["camel"] }, flags) }, { "exclude-tag": ["camel"] });
  assert.deepEqual({ ...canonicalRegenerationOptions({ excludeTags: ["alias"], excludeTag: ["camel"], "exclude-tag": "exact" }, flags) }, { "exclude-tag": "exact" });
  assert.deepEqual({ ...canonicalRegenerationOptions({ excludeTags: ["alias"] }, [{ long: "--output" }]) }, {});
});

test("a source-backed close reason edited after publication is refused; an unchanged one is attributed", async (t) => {
  const facets = JSON.stringify([{ audience: "operator", source: "close_reason" }]);
  const f = await releaseFixture(t, [["release-reason-kept", "2026-11-01T00:00:00Z"], ["release-reason-edited", "2026-11-01T00:00:00Z"]], facets);
  const published = f.commit("2026-11-02T00:00:00Z");
  // Another implemented reason passes every other frozen check, but the published notes carry the original text.
  await runUpdate("release-reason-edited", { closeReason: "Implemented differently" }, { path: f.pmRoot });
  const skipped: string[] = [];
  assert.deepEqual(await attributeRenderingRelease(f.pmRoot, "2.0.0", { cwd: f.cwd, preparedFrom: published, publication: { state: "published", gitHead: published }, log: (id) => { skipped.push(id); } }), ["release-reason-kept"]);
  assert.deepEqual(skipped, ["release-reason-edited"]);
  assert.equal((await listAllComplete({}, { pmRoot: f.pmRoot })).items.find((row) => row.id === "release-reason-edited")!.release, undefined);
});

test("release attribution docs describe the end of the recorded commit second", () => {
  const docs = readFileSync(resolve("docs/release.md"), "utf8");
  assert.match(docs, /before the end of the boundary commit's\s+recorded second/);
  assert.doesNotMatch(docs, /completion timestamp strictly before the boundary commit/);
});
