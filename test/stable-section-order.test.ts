import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { PmClient, runInit } from "@unbrained/pm-cli/sdk";
import { buildChangelogDocument, createChangelog, createChangelogSummary, readPmItems, writeChangelog } from "../src/index.ts";
import type { GenerateChangelogOptions, PmItem } from "../src/index.ts";

/** Create native records in a plain directory, with deliberately separated lifecycle times. */
async function tracker(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pm-stable-section-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, ".agents/pm");
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T00:00:00Z") });
  await runInit("stable", { path: root }, { defaults: true, agentGuidance: "skip" });
  const client = new PmClient({ pmRoot: root, author: "ordering-test" });
  for (const [id, title] of [["stable-old", "Maintain alpha"], ["stable-new", "Maintain beta"], ["stable-done", "Maintain gamma"]]) {
    t.mock.timers.tick(1000);
    await client.create({ id, title, type: "Task", status: "in_progress", createMode: "progressive", unset: ["parent", "goal", "objective", "sprint", "release"] });
  }
  t.mock.timers.tick(1000);
  await client.close("stable-done", "Implemented the maintenance change");
  t.mock.timers.tick(1000);
  await client.comments("stable-new", { add: "Initial progress evidence" });
  const options = (): GenerateChangelogOptions => ({
    items: readPmItems({ pmRoot: root, cwd }),
    includeStatuses: ["closed", "in_progress"],
    version: "1.0.0",
    date: "2026-11-01",
  });
  return { cwd, root, client, options };
}

/** Drive the shipped release-note/JSON/check modes against the real tracker. */
function cli(root: string, cwd: string, args: string[]): string {
  const result = spawnSync(process.execPath, [resolve("dist/cli.js"), "--pm-root", root,
    "--status", "closed,in_progress", "--version", "1.0.0", "--date", "2026-11-01", ...args],
  { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

for (const mutation of ["comment", "file", "claim"] as const) {
  test(`${mutation} preserves CHANGELOG.md, release notes, JSON, summary and check bytes`, async (t) => {
    const { cwd, root, client, options } = await tracker(t);
    const output = join(cwd, "CHANGELOG.md");
    writeChangelog({ ...options(), output, mode: "replace" });
    const before = readFileSync(output, "utf8");
    const notes = cli(root, cwd, ["--stdout"]);
    const json = cli(root, cwd, ["--format", "json"]);
    const summary = JSON.stringify(createChangelogSummary(options()));
    const updated = (await client.get("stable-old", { full: true })).item.updated_at;
    t.mock.timers.tick(1000);
    if (mutation === "comment") await client.comments("stable-old", { add: "Progress evidence" });
    if (mutation === "file") await client.files("stable-old", { add: ["src/maintenance.ts"] });
    if (mutation === "claim") await client.claim("stable-old");
    assert.notEqual((await client.get("stable-old", { full: true })).item.updated_at, updated);
    assert.equal(createChangelog(options()).markdown, before, "CHANGELOG.md bytes");
    assert.equal(cli(root, cwd, ["--stdout"]), notes, "release-note bytes");
    assert.equal(cli(root, cwd, ["--format", "json"]), json, "JSON bytes");
    assert.equal(JSON.stringify(createChangelogSummary(options())), summary, "summary bytes");
    cli(root, cwd, ["--output", output, "--mode", "replace", "--check"]);
    assert.equal(readFileSync(output, "utf8"), before, "check preserves committed bytes");
  });
}

test("closing an item promotes it from creation order into newest completion order", async (t) => {
  const { client, options } = await tracker(t);
  const ids = () => createChangelogSummary(options()).map((item) => item.id);
  assert.deepEqual(ids(), ["stable-done", "stable-new", "stable-old"]);
  t.mock.timers.tick(1000);
  await client.close("stable-old", "Implemented the maintenance change");
  assert.deepEqual(ids(), ["stable-old", "stable-done", "stable-new"]);
  const markdown = createChangelog(options()).markdown;
  assert.ok(markdown.indexOf("stable-old") < markdown.indexOf("stable-done"));
});

test("completion fields and stable creation/id keys define a total order across input permutations", () => {
  const items: PmItem[] = [
    { id: "done-new", title: "Maintain A", completed_at: "2026-11-02", closed_at: "2026-10-01" },
    { id: "done-old", title: "Maintain B", closed_at: "2026-11-01", updated_at: "2027-01-01" },
    { id: "open-a", title: "Maintain Z", created_at: "2026-11-04", updated_at: "2027-01-01" },
    { id: "open-b", title: "Maintain A", created_at: "2026-11-04" },
    { id: "legacy", title: "Maintain legacy", status: "closed", created_at: "2026-11-03" },
    { id: "undated", title: "Maintain undated", created_at: "invalid", updated_at: "2026-11-05" },
    { title: "Maintain no id" },
  ];
  const expected = ["done-new", "done-old", "open-a", "open-b", "legacy", undefined, "undated"];
  for (let offset = 0; offset < items.length; offset++) {
    for (const permutation of [items.slice(offset).concat(items.slice(0, offset)), items.slice(offset).concat(items.slice(0, offset)).reverse()]) {
      const options = { items: permutation, includeStatuses: [], sectionBy: "type" as const };
      assert.deepEqual(createChangelogSummary(options).map((item) => item.id), expected);
      assert.deepEqual(buildChangelogDocument(options).releases[0].sections[0].items.map((item) => item.id), expected);
    }
  }
  const mixed: PmItem[] = [
    { id: "a", title: "A", type: "Task", status: "closed", updated_at: "2026-10-19" },
    { id: "b", title: "B", type: "Feature", status: "closed" },
    { id: "c", title: "C", type: "Task", status: "closed", updated_at: "2026-10-20" },
  ];
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const reference = { items: mixed, sectionBy: "type" as const };
  for (const order of permutations) {
    const options = { ...reference, items: order.map((index) => mixed[index]) };
    assert.equal(createChangelog(options).markdown, createChangelog(reference).markdown);
    assert.deepEqual(buildChangelogDocument(options), buildChangelogDocument(reference));
  }
  const tied: PmItem[] = [
    { id: "done-b", title: "Maintain same", completed_at: "2026-11-02" },
    { id: "done-a", title: "Maintain same", completed_at: "2026-11-02" },
    { id: "done-z", title: "Maintain earlier title", completed_at: "2026-11-02" },
    { title: "Maintain same", completed_at: "2026-11-02" },
    { title: "Maintain no id B" },
    { title: "Maintain no id A" },
  ];
  for (const ordering of [tied, tied.slice().reverse()]) {
    const entries = createChangelogSummary({ items: ordering, includeStatuses: [] });
    assert.deepEqual(entries.map((item) => item.title),
      ["Maintain earlier title", "Maintain same", "Maintain same", "Maintain same", "Maintain no id A", "Maintain no id B"]);
    assert.deepEqual(entries.map((item) => item.id), ["done-z", undefined, "done-a", "done-b", undefined, undefined]);
  }
});

test("derived lists keep explicit order through SDK writes and completion transitions", async (t) => {
  const { cwd, root, options } = await tracker(t);
  const alpha = new PmClient({ cwd, pmRoot: root, author: "alpha" });
  const zeta = new PmClient({ cwd, pmRoot: root, author: "zeta" });
  const seed = { type: "Task", status: "in_progress", tags: "breaking", createMode: "progressive", unset: ["parent", "goal", "objective", "sprint", "release"] };
  t.mock.timers.tick(1000);
  await alpha.create({ ...seed, id: "stable-derived-open", title: "Maintain active contract" });
  t.mock.timers.tick(1000);
  await zeta.create({ ...seed, id: "stable-derived-closed", title: "Maintain completed contract" });
  t.mock.timers.tick(1000);
  await zeta.close("stable-derived-closed", "Implemented the contract change");
  /** Read current native rows while exercising both optional derived lists. */
  const derivedOptions = (): GenerateChangelogOptions => ({ ...options(), contributors: true, breakingChanges: true });
  const document = buildChangelogDocument(derivedOptions());
  assert.deepEqual(document.releases[0].contributors, ["alpha", "ordering-test", "zeta"]);
  assert.deepEqual(document.releases[0].breaking_changes?.map((item) => item.id), ["stable-derived-closed", "stable-derived-open"]);
  const markdown = createChangelog(derivedOptions()).markdown;
  assert.match(markdown, /### Contributors\n\n@alpha, @ordering-test, @zeta\n/);
  const notes = cli(root, cwd, ["--stdout", "--contributors", "--breaking-changes"]);
  t.mock.timers.tick(1000);
  await alpha.comments("stable-derived-open", { add: "Additional contract evidence" });
  assert.deepEqual(buildChangelogDocument(derivedOptions()), document);
  assert.equal(createChangelog(derivedOptions()).markdown, markdown);
  assert.equal(cli(root, cwd, ["--stdout", "--contributors", "--breaking-changes"]), notes);
  t.mock.timers.tick(1000);
  await alpha.close("stable-derived-open", "Implemented the active contract");
  const completed = buildChangelogDocument(derivedOptions()).releases[0];
  assert.deepEqual(completed.contributors, ["alpha", "ordering-test", "zeta"]);
  assert.deepEqual(completed.breaking_changes?.map((item) => item.id), ["stable-derived-open", "stable-derived-closed"]);
});

test("contributor handles have lexical order and deterministic case aliases", () => {
  const inputs: PmItem[] = [
    { id: "pm-a", title: "Maintain first credit", assignee: "Zed" },
    { id: "pm-b", title: "Maintain second credit", assignee: "alpha" },
    { id: "pm-c", title: "Maintain third credit", author: " beta " },
    { id: "pm-d", title: "Maintain fourth credit", assignee: "ALPHA" },
    { id: "pm-e", title: "Maintain fifth credit", author: "Alpha" },
    { id: "pm-f", title: "Maintain fallback credit", assignee: " unknown ", author: "gamma" },
    { id: "pm-g", title: "Maintain uncredited item", author: "unknown" },
  ];
  for (let offset = 0; offset < inputs.length; offset++) {
    const rotated = inputs.slice(offset).concat(inputs.slice(0, offset));
    for (const ordering of [rotated, rotated.slice().reverse()]) {
      const items = ordering.map((item, index) => ({ ...item,
        created_at: new Date(Date.parse("2026-11-01") + index * 1000).toISOString(),
        updated_at: new Date(Date.parse("2026-11-02") + (offset - index) * 1000).toISOString(),
      }));
      const options = { items, includeStatuses: [], contributors: true };
      assert.deepEqual(buildChangelogDocument(options).releases[0].contributors, ["ALPHA", "beta", "gamma", "Zed"]);
      assert.match(createChangelog(options).markdown, /### Contributors\n\n@ALPHA, @beta, @gamma, @Zed\n/);
    }
  }
});
