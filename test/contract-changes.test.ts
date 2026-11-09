import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { marked } from "marked";
import { listAllComplete, runCreate, runInit, runUpdate, runWithActiveExtensions, schemaAddField } from "@unbrained/pm-cli/sdk";
import { auditChangelogClaims, buildChangelogDocument, createChangelog, createChangelogSummary, createReleaseMilestone, DirectoryReleaseMilestoneStore, resolveTrackerReleaseHistory } from "../src/index.ts";
import type { PmItem } from "../src/index.ts";

const declaration = { api: "listAllComplete", before: "Rows were unordered", after: "Rows use ID order", migrate: "Sort explicitly for other orders" };

test("real SDK declarations render once with migration in Markdown and JSON without git", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-contract-change-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, ".agents/pm");
  await runInit("pm", { path: root }, { defaults: true, agentGuidance: "skip" });
  await schemaAddField("contract_change", { type: "object" }, { pmRoot: root });
  for (const [id, title] of [["fixture-fix", "Fix default order"], ["fixture-security", "Security refusal"]]) {
    await runCreate({ id, title, type: "Issue", status: "closed", closeReason: "Fixed behavior; merged PR #12", createMode: "progressive",
      ...{ contractChange: JSON.stringify(declaration) } }, { path: root, author: "fixture" });
  }
  const items = (await listAllComplete({}, { pmRoot: root })).items as PmItem[];
  const options = { items, date: "2026-11-06" };
  const markdown = createChangelog(options).markdown;
  assert.match(markdown, /### Changed \(SDK contract\)/);
  assert.match(markdown, /Fix default order: Rows were unordered → Rows use ID order\. Migrate: Sort explicitly for other orders/);
  assert.doesNotMatch(markdown, /### Fixed|### Security/);
  for (const item of items) assert.equal(markdown.split(`(${item.id})`).length - 1, 1);
  const document = buildChangelogDocument(options);
  assert.equal(document.releases[0].sections[0].heading, "Changed (SDK contract)");
  for (const item of document.releases[0].sections[0].items) {
    assert.deepEqual((item as unknown as Record<string, unknown>).contract_change, declaration);
  }
  const env = { ...process.env, PM_GLOBAL_PATH: join(cwd, "global"), PM_PATH: root, DO_NOT_TRACK: "1", GIT_CEILING_DIRECTORIES: dirname(cwd) };
  for (const flags of [["--stdout"], ["--changelog-json"]]) {
    const run = spawnSync(process.execPath, [resolve("dist/cli.js"), "--pm-root", root, "--date", "2026-11-06", ...flags], { cwd, env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    if (flags[0] === "--stdout") assert.equal(run.stdout, markdown);
    else assert.deepEqual(JSON.parse(run.stdout), JSON.parse(JSON.stringify(document)));
  }
});

test("audit maps exact contract lines and reports absent migration text", () => {
  for (const migrate of [undefined, "", "  ", 7]) {
    const item: PmItem = { id: "fixture-gap", title: "Fix contract", type: "Issue", status: "closed", close_reason: "Fixed behavior; merged PR #12",
      metadata: { contract_change: { ...declaration, migrate } } };
    const options = { items: [item], date: "2026-11-06" };
    const report = auditChangelogClaims(options);
    assert.equal(report.claims[0].section, "Changed (SDK contract)");
    assert.ok(report.claims[0].gaps.some((gap) => String(gap) === "migration"));
    assert.equal(report.claims[0].claim, createChangelog(options).markdown.split("\n")[report.claims[0].line - 1]);
    assert.deepEqual(report.claims[0].items, [item.id]);
    assert.equal(report.ready, false);
  }
});

test("declarations override every presentation group and breaking duplication without changing undeclared output", () => {
  const legacy: PmItem = { id: "fixture-old", title: "Repair parser", type: "Issue", status: "closed", close_reason: "Fixed parser", tags: ["one", "two"] };
  const declared: PmItem = { ...legacy, id: "fixture-new", title: "Security fix", breaking: true, contract_change: declaration };
  const legacyOptions = { items: [legacy], date: "2026-11-06" };
  assert.equal(createChangelog(legacyOptions).markdown, "# Changelog\n\n## Unreleased - 2026-11-06\n\n### Fixed\n\n- Repair parser (fixture-old)\n");
  assert.equal(Object.hasOwn(buildChangelogDocument(legacyOptions).releases[0].sections[0].items[0], "contract_change"), false);
  for (const sectionBy of ["category", "type", "status", "label"] as const) {
    const options = { items: [declared, legacy], sectionBy, breakingChanges: true, conventional: true, emojiPrefix: true, entryFrom: "close_reason" as const, date: "2026-11-06" };
    const output = createChangelog(options).markdown;
    assert.equal(output.split("(fixture-new)").length - 1, 1);
    assert.match(output, /Security fix: Rows were unordered → Rows use ID order\. Migrate: Sort explicitly for other orders/);
    const document = buildChangelogDocument(options);
    assert.deepEqual(document.releases[0].breaking_changes, []);
    const group = document.releases[0].sections.find((row) => row.heading === "Changed (SDK contract)")!;
    assert.deepEqual(group.items.map((item) => item.id), [declared.id]);
    assert.equal(group.items[0].title, declared.title);
    assert.equal(createChangelogSummary(options).find((row) => row.id === declared.id)!.title, declared.title);
    assert.equal(createChangelogSummary(options).filter((row) => row.id === declared.id).length, 1);
  }
});

test("malformed historical declarations remain readable with explicit audit gaps and safe single-line prose", () => {
  for (const contract_change of [null, false, 3, "old value", [], {}, { ...declaration, before: 3 }, { ...declaration, after: " " }]) {
    const item: PmItem = { id: "fixture-malformed", title: "Contract", status: "closed", contract_change };
    const report = auditChangelogClaims({ items: [item] });
    assert.ok(report.claims[0].gaps.some((gap) => String(gap) === "contract_change"));
    assert.equal(report.claims[0].gaps.includes("migration"), !(contract_change && typeof contract_change === "object" && "migrate" in contract_change));
  }
  const item: PmItem = { id: "fixture-text", title: "Contract", status: "closed", contract_change: { ...declaration, api: " ", before: "  [before]\nline  ", after: "*after*", migrate: "  `sort`\nnow  " }, metadata: { contract_change: { before: "ignored" } } };
  const options = { items: [item] };
  const markdown = createChangelog(options).markdown;
  assert.match(markdown, /\\\[before\\\] line → \\\*after\\\*\. Migrate: `sort` now/);
  const value = buildChangelogDocument(options).releases[0].sections[0].items[0].contract_change!;
  assert.equal(value.before, "[before]\nline");
  assert.equal(Object.hasOwn(value, "api"), false);
  const report = auditChangelogClaims(options);
  assert.equal(report.claims[0].claim, markdown.split("\n")[report.claims[0].line - 1]);
  assert.equal(report.claims[0].gaps.includes("migration"), false);
});

test("complete contract evidence passes audit while ordinary release and status exclusions still apply", () => {
  const item: PmItem = { id: "fixture-supported", title: "Fix order", status: "closed", type: "Issue", close_reason: "Fixed order; merged PR #12", contract_change: declaration,
    release: "2.0.0", tests: [{ command: "node --test ordering.test.ts" }] };
  const options = { items: [item], version: "2.0.0", respectItemRelease: true };
  const receipts = [{ item: item.id!, command: "node --test ordering.test.ts", outcome: "passed" as const, reference: "https://example.com/ci/12" }];
  assert.equal(auditChangelogClaims(options, receipts).ready, true);
  const report = auditChangelogClaims({ ...options, items: [{ ...item, contract_change: { ...declaration, migrate: " " } }] }, receipts);
  assert.deepEqual(report.claims[0].gaps, ["migration"]);
  for (const excluded of [{ ...item, status: "open" }, { ...item, release: "1.0.0" }, { ...item, close_reason: "Duplicate of fixture-original" }]) {
    assert.equal(createChangelog({ ...options, items: [excluded] }).itemCount, 0);
  }
  assert.equal(buildChangelogDocument({ ...options, items: [{ ...item, breaking: true }], suggestSemver: true }).suggested_semver!.bump, "major");
  const unsupported: PmItem = { ...item, type: "Task", close_reason: "Delivered behavior", tests: [] };
  assert.ok(auditChangelogClaims({ items: [unsupported] }).claims[0].gaps.includes("repair"));
  const feature = { ...item, type: "Feature", title: "New API" };
  assert.equal(buildChangelogDocument({ items: [feature], suggestSemver: true }).suggested_semver!.bump, "minor");
});

test("actual extension authors declarations and host audit finds SDK-created missing migrations", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-contract-host-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, ".agents/pm");
  await runInit("pm", { path: root }, { defaults: true, agentGuidance: "skip" });
  const target = join(root, "extensions/pm-changelog");
  mkdirSync(target, { recursive: true });
  cpSync(resolve("dist"), join(target, "dist"), { recursive: true });
  cpSync(resolve("manifest.json"), join(target, "manifest.json"));
  writeFileSync(join(target, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(resolve("node_modules"), join(target, "node_modules"), "junction");
  await runWithActiveExtensions({ path: root }, async () => {
    await runCreate({ title: "CLI contract", type: "Task", status: "closed", closeReason: "Delivered contract", createMode: "progressive",
      field: [`contract_change=${JSON.stringify({ before: "Allowed", after: "Refused" })}`] }, { path: root, author: "fixture" });
  });
  const items = (await listAllComplete({}, { pmRoot: root })).items as PmItem[];
  const env = { ...process.env, PM_GLOBAL_PATH: join(cwd, "global"), PM_PATH: root, DO_NOT_TRACK: "1", GIT_CEILING_DIRECTORIES: dirname(cwd) };
  const args = ["--path", root, "changelog", "audit", "--format", "json"];
  const run = spawnSync(process.execPath, [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), ...args], { cwd, env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout) as ReturnType<typeof auditChangelogClaims>;
  assert.equal(report.claims[0].section, "Changed (SDK contract)");
  assert.ok(report.claims[0].gaps.includes("migration"));
  assert.deepEqual(report.claims[0].items, [items[0].id]);
  for (const metadata of [false, true]) {
    const item: PmItem = metadata ? { ...items[0], contract_change: undefined, metadata: { contract_change: declaration } } : items[0];
    const milestone = await createReleaseMilestone(new DirectoryReleaseMilestoneStore(join(cwd, `store-${metadata}`)), "1.0.0", { capturedAt: "2026-11-06T00:00:00Z", items: [item] });
    const history = resolveTrackerReleaseHistory([milestone], []);
    assert.match(createChangelog(history).markdown, /### Changed \(SDK contract\)/);
    assert.deepEqual(buildChangelogDocument(history).releases[0].sections[0].items[0].contract_change, metadata ? declaration : { before: "Allowed", after: "Refused", migrate: "" });
  }
});


test("declared issues without repair evidence publish their contract entry in every output", () => {
  for (const type of ["Issue", "Bug", "Defect", "Bugfix"]) {
    for (const sectionBy of ["category", "type", "status", "label"] as const) {
      const item: PmItem = { id: "fixture-neutral", title: "Security parser change", type, status: "closed", close_reason: "Closed on GitHub", breaking: true, tags: ["one", "two"], contract_change: declaration };
      const options = { items: [item], sectionBy, entryFrom: "close_reason" as const, breakingChanges: true, suggestSemver: true };
      const markdown = createChangelog(options).markdown;
      assert.match(markdown, /### Changed \(SDK contract\)\n\n- Security parser change: Rows were unordered → Rows use ID order\. Migrate: Sort explicitly for other orders \(fixture-neutral\)/);
      assert.doesNotMatch(markdown, /### Closed|Closed:|Breaking Changes/);
      const document = buildChangelogDocument(options);
      assert.deepEqual(document.releases[0].breaking_changes, []);
      assert.equal(document.releases[0].sections[0].heading, "Changed (SDK contract)");
      assert.deepEqual(document.releases[0].sections[0].items[0].contract_change, declaration);
      assert.equal(document.releases[0].sections[0].items[0].title, "Security parser change");
      // Unproven closures never contribute to breaking or semver classification, declared or not.
      assert.equal(document.suggested_semver!.bump, "none");
      assert.equal(createChangelogSummary(options)[0].title, "Security parser change");
      const report = auditChangelogClaims(options);
      assert.equal(report.claims.length, 1);
      assert.equal(report.claims[0].section, "Changed (SDK contract)");
      assert.equal(report.claims[0].claim, markdown.split("\n")[report.claims[0].line - 1]);
      assert.equal(report.claims[0].gaps.includes("repair"), false);
      for (const gap of ["delivery", "tests", "test_result"] as const) assert.ok(report.claims[0].gaps.includes(gap));
      assert.equal(report.claims[0].gaps.includes("migration"), false);
      assert.equal(report.claims[0].gaps.includes("contract_change"), false);
      // Incomplete neutral declarations still publish and audit their missing migration text.
      const incomplete = { ...options, items: [{ ...item, contract_change: { ...declaration, before: " ", migrate: "" } }] };
      assert.match(createChangelog(incomplete).markdown, /Security parser change: \\\[missing before\\\] → Rows use ID order\. Migrate: \\\[missing migration\\\]/);
      const incompleteReport = auditChangelogClaims(incomplete);
      assert.ok(incompleteReport.claims[0].gaps.includes("migration"));
      assert.ok(incompleteReport.claims[0].gaps.includes("contract_change"));
      assert.equal(incompleteReport.ready, false);
      // Linked repair evidence restores the major bump while the entry stays in the contract group.
      const repaired = { ...options, items: [{ ...item, files: [{ path: "src/parser.ts" }] }] };
      assert.match(createChangelog(repaired).markdown, /### Changed \(SDK contract\)/);
      assert.match(createChangelog(repaired).markdown, /Migrate: Sort explicitly for other orders/);
      assert.equal(buildChangelogDocument(repaired).suggested_semver!.bump, "major");
    }
  }
});

test("contract Markdown isolates fields and matches only complete equal backtick runs", () => {
  const cases = [
    { before: "`before", after: "after`", migrate: "`migrate", spans: [] },
    { before: "`before``", after: "``after`", migrate: "``migrate`", spans: [] },
    { before: "``before```", after: "```after``", migrate: "`migrate``", spans: [] },
    { before: "`before`` tail`", after: "``after``` tail``", migrate: "`use` now", spans: ["before`` tail", "after``` tail", "use"] },
    { before: "`unmatched ``inner``", after: "`after`", migrate: " ", spans: ["inner", "after"] },
    { before: "", after: "", migrate: "", spans: [] },
    { before: "[before]\nline", after: "*after*", migrate: "`sort`\nnow", spans: ["sort"] },
  ];
  for (const fields of cases) {
    const item: PmItem = { id: "fixture-fences", title: "Contract`", status: "closed", contract_change: fields };
    const options = { items: [item] };
    const markdown = createChangelog(options).markdown;
    const report = auditChangelogClaims(options);
    const bullet = markdown.split("\n").find((line) => line.startsWith("- "))!;
    assert.equal(report.claims[0].claim, bullet);
    assert.equal(markdown.split("\n")[report.claims[0].line - 1], bullet);
    const html = marked.parseInline(bullet, { async: false });
    assert.deepEqual([...html.matchAll(/<code>(.*?)<\/code>/g)].map((match) => match[1]), fields.spans);
    assert.ok(html.includes(" → "));
    assert.ok(html.includes(". Migrate: "));
    assert.ok(html.includes("Contract`: "));
    for (const name of ["before", "after", "migrate"] as const) {
      if (!fields[name].trim()) assert.ok(html.includes(`[missing ${name === "migrate" ? "migration" : name}]`));
    }
    assert.doesNotMatch(html, /<em>|<strong>|<a /);
  }
});

test("active extension runUpdate persists and replaces contract_change without git", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-contract-update-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, ".agents/pm");
  await runInit("pm", { path: root }, { defaults: true, agentGuidance: "skip" });
  const target = join(root, "extensions/pm-changelog");
  mkdirSync(target, { recursive: true });
  cpSync(resolve("dist"), join(target, "dist"), { recursive: true });
  cpSync(resolve("manifest.json"), join(target, "manifest.json"));
  writeFileSync(join(target, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(resolve("node_modules"), join(target, "node_modules"), "junction");
  await runWithActiveExtensions({ path: root }, async () => {
    const created = await runCreate({ title: "Updated contract", type: "Task", status: "open", createMode: "progressive" }, { path: root, author: "fixture" });
    const id = created.item.id;
    for (const contract of [declaration, { before: "Allowed", after: "Refused", migrate: "Handle the refusal" }]) {
      await runUpdate(id, { field: [`contract_change=${JSON.stringify(contract)}`] }, { path: root, author: "fixture" });
      const stored = (await listAllComplete({}, { pmRoot: root })).items.find((item) => item.id === id)!;
      assert.deepEqual(stored.contract_change, contract);
      assert.equal(stored.title, "Updated contract");
      const document = buildChangelogDocument({ items: [stored as PmItem], includeStatuses: ["open"] });
      assert.deepEqual(document.releases[0].sections[0].items[0].contract_change, contract);
    }
  });
});
