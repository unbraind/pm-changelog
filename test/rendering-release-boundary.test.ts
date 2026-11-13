import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { listAllComplete, runCreate, runInit } from "@unbrained/pm-cli/sdk";
import { attributeRenderingRelease } from "../scripts/attribute-rendering-release.ts";
import { resolveRenderingReleaseBoundary } from "../scripts/rendering-release-boundary.ts";
import type { PublicationState } from "../scripts/rendering-release-boundary.ts";
import { fixtureEnvironment, initGitFixture } from "./git-fixture.ts";

/** Make first-version F, actual publication P, and later recovery R real Git snapshots. */
async function publicationFixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pm-publication-boundary-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  initGitFixture(cwd, ["-b", "main"]);
  const pmRoot = join(cwd, ".agents/pm");
  await runInit("release", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "2.0.0" }));
  /** Execute only owned fixture Git operations with explicit identity and date. */
  const git = (args: string[], date = "2026-11-05T00:00:00Z"): string => execFileSync("git", ["-c", "user.name=SteveBot", "-c", "user.email=1153461+unbraind@users.noreply.github.com", ...args],
    { cwd, env: { ...fixtureEnvironment(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  /** Persist complete native fixture rows and retain the immutable commit ID. */
  const commit = (date: string): string => { git(["add", "package.json", ".agents/pm"]); git(["commit", "--allow-empty", "-m", "Publication boundary fixture"], date); return git(["rev-parse", "HEAD"]); };
  const first = commit("2026-11-01T00:00:00Z");
  await runCreate({ id: "release-between", title: "Delivered between version and publication", type: "Task", status: "closed", tags: "rendering-change", completedAt: "2026-11-02T00:00:00Z", closeReason: "Implemented", createMode: "progressive" }, { path: pmRoot });
  const published = commit("2026-11-03T00:00:00Z");
  await runCreate({ id: "release-after", title: "Delivered after publication", type: "Task", status: "closed", tags: "rendering-change", completedAt: "2026-11-04T00:00:00Z", closeReason: "Implemented", createMode: "progressive" }, { path: pmRoot });
  const recovery = commit("2026-11-05T00:00:00Z");
  return { cwd, pmRoot, git, commit, first, published, recovery };
}

test("publication gitHead after the first version commit includes intervening delivered items", async (t) => {
  const f = await publicationFixture(t);
  // A stale tag cannot override the registry's proved publication object.
  f.git(["tag", "v2.0.0", f.first]);
  const publication = { state: "published" as const, gitHead: f.published };
  const boundary = await resolveRenderingReleaseBoundary(f.cwd, f.pmRoot, "2.0.0", f.recovery, publication);
  assert.equal(boundary?.commit, f.published);
  assert.ok(boundary.items.has("release-between"));
  assert.ok(!boundary.items.has("release-after"));
  const skipped: string[] = [];
  assert.deepEqual(await attributeRenderingRelease(f.pmRoot, "2.0.0", { cwd: f.cwd, preparedFrom: f.recovery, publication, log: (id) => { skipped.push(id); } }), ["release-between"]);
  const rows = (await listAllComplete({}, { pmRoot: f.pmRoot })).items;
  assert.equal(rows.find((row) => row.id === "release-between")!.release, "2.0.0");
  assert.equal(rows.find((row) => row.id === "release-after")!.release, undefined);
  assert.deepEqual(skipped, ["release-after"]);
});

test("published recovery never advances the publication snapshot to its decision base", async (t) => {
  const f = await publicationFixture(t);
  const boundary = await resolveRenderingReleaseBoundary(f.cwd, f.pmRoot, "2.0.0", f.recovery, { state: "published", gitHead: f.published });
  assert.equal(boundary?.commit, f.published);
  assert.notEqual(boundary.commit, f.recovery);
  assert.ok(!boundary.items.has("release-after"));
});

test("published boundary uses the version tag only when npm gitHead is absent", async (t) => {
  const f = await publicationFixture(t);
  f.git(["tag", "v2.0.0", f.published]);
  const boundary = await resolveRenderingReleaseBoundary(f.cwd, f.pmRoot, "2.0.0", f.recovery, { state: "published" });
  assert.equal(boundary?.commit, f.published);
  for (const gitHead of ["a".repeat(40), "HEAD", ""]) {
    const reasons: string[] = [];
    assert.equal(await resolveRenderingReleaseBoundary(f.cwd, f.pmRoot, "2.0.0", f.recovery, { state: "published", gitHead }, (reason) => { reasons.push(reason); }), undefined);
    assert.equal(reasons.length, 1, "Unproved gitHead must not borrow the valid tag");
  }
});

test("an annotated version tag resolves to the published commit, not the tag object", async (t) => {
  const f = await publicationFixture(t);
  f.git(["tag", "-a", "v2.0.0", "-m", "Release 2.0.0", f.published]);
  const tagObject = f.git(["rev-parse", "refs/tags/v2.0.0"]);
  assert.notEqual(tagObject, f.published, "the fixture tag must be an annotated tag object");
  const boundary = await resolveRenderingReleaseBoundary(f.cwd, f.pmRoot, "2.0.0", f.recovery, { state: "published" });
  assert.equal(boundary?.commit, f.published);
  assert.ok(boundary.items.has("release-between"));
  // Must refuse: an annotated tag that peels to a tree names no published commit.
  f.git(["tag", "-d", "v2.0.0"]);
  f.git(["tag", "-a", "v2.0.0", "-m", "Release 2.0.0", `${f.published}^{tree}`]);
  const reasons: string[] = [];
  assert.equal(await resolveRenderingReleaseBoundary(f.cwd, f.pmRoot, "2.0.0", f.recovery, { state: "published" }, (reason) => { reasons.push(reason); }), undefined);
  assert.equal(reasons.length, 1);
});

test("unproved publication cannot borrow the first version commit or recovery HEAD", async (t) => {
  const f = await publicationFixture(t);
  for (const publication of [{ state: "published" }, { state: "unknown" }] satisfies PublicationState[]) {
    const skipped: { id: string; reason: string }[] = [];
    const reason = publication.state === "unknown" ? "publication_state_unknown" : "published_commit_unavailable";
    await assert.rejects(() => attributeRenderingRelease(f.pmRoot, "2.0.0", { cwd: f.cwd, preparedFrom: f.recovery, publication, log: (id, reason) => { skipped.push({ id, reason }); } }), new RegExp(`Rendering release attribution refused: ${reason}`));
    assert.equal(skipped.length, 2);
    assert.ok(skipped.every((entry) => entry.reason === reason));
  }
  assert.ok((await listAllComplete({}, { pmRoot: f.pmRoot })).items.every((row) => row.release === undefined));
});

test("published objects must match the version and be reachable from canonical main", async (t) => {
  const f = await publicationFixture(t);
  f.git(["checkout", "-b", "unmerged"]);
  const unmerged = f.commit("2026-11-06T00:00:00Z");
  f.git(["checkout", "main"]);
  writeFileSync(join(f.cwd, "package.json"), JSON.stringify({ name: "fixture", version: "3.0.0" }));
  const wrongVersion = f.commit("2026-11-07T00:00:00Z");
  for (const [gitHead, reason] of [[unmerged, "published_commit_not_reachable_from_main"], [wrongVersion, "published_commit_version_mismatch"]]) {
    const reasons: string[] = [];
    assert.equal(await resolveRenderingReleaseBoundary(f.cwd, f.pmRoot, "2.0.0", wrongVersion, { state: "published", gitHead }, (value) => { reasons.push(value); }), undefined);
    assert.deepEqual(reasons, [reason]);
  }
  f.git(["update-ref", "refs/remotes/origin/main", f.first]);
  assert.equal(await resolveRenderingReleaseBoundary(f.cwd, f.pmRoot, "2.0.0", wrongVersion, { state: "published", gitHead: f.published }), undefined, "Recovery/local main cannot bypass fetched main ancestry");
});

test("published snapshot with no main ref is unproved rather than inferred from HEAD", async (t) => {
  const f = await publicationFixture(t);
  f.git(["branch", "-m", "main", "recovery"]);
  const reasons: string[] = [];
  assert.equal(await resolveRenderingReleaseBoundary(f.cwd, f.pmRoot, "2.0.0", f.recovery, { state: "published", gitHead: f.published }, (reason) => { reasons.push(reason); }), undefined);
  assert.deepEqual(reasons, ["published_commit_not_reachable_from_main"]);
});
