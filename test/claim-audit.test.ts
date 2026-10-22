import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { runCreate } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import { initGitFixture } from "./git-fixture.ts";
import { cliTestSurface } from "../src/cli.ts";
import extension from "../src/extension.ts";
import { auditChangelogClaims, assertChangelogClaims, formatClaimAudit, parseClaimTestReceipts, ClaimAuditError, createChangelog } from "../src/index.ts";
import type { ClaimTestReceipt, PmItem } from "../src/index.ts";

const base: PmItem = { id: "fixture-a", title: "Repair parser", type: "Issue", status: "closed", close_reason: "Fixed parsing; merged PR #12", tests: [{ command: "node --test parser.test.ts" }] };
const receipt: ClaimTestReceipt = { item: "fixture-a", command: "node --test parser.test.ts", outcome: "passed", reference: "https://example.com/ci/12" };

test("exact rendered lines retain factual closure and every explicit gap", () => {
  const factual = { ...base, close_reason: "Closed on GitHub as completed", tests: [] };
  const options = { title: "Changelog\nSubtitle", items: [factual], entryFrom: "close_reason" as const };
  const report = auditChangelogClaims(options);
  const markdown = createChangelog(options).markdown;
  assert.equal(report.claims[0].section, "Closed");
  assert.match(report.claims[0].claim, /^- Closed: Repair parser/);
  assert.deepEqual(report.claims[0].gaps, ["delivery", "test_result", "tests"]);
  assert.equal(report.markdown_sha256, createHash("sha256").update(markdown).digest("hex"));
  for (const row of report.claims) assert.equal(row.claim, markdown.split("\n")[row.line - 1]);
  assert.throws(() => assertChangelogClaims(report), (error: unknown) => error instanceof ClaimAuditError && error.code === "unsupported_claims" && error.report === report && !!error.remedy && error.exitCode === 1);
  const noResolution = auditChangelogClaims({ items: [{ ...base, close_reason: undefined, tests: undefined }] });
  assert.ok(noResolution.claims[0].gaps.includes("resolution"));
  assert.equal(noResolution.evidence[0].tests.length, 0);
});

test("test declarations never prove passing and failed receipts dominate", () => {
  assert.ok(auditChangelogClaims({ items: [base] }).claims[0].gaps.includes("test_result"));
  const supported = auditChangelogClaims({ items: [base] }, [receipt]);
  assert.equal(supported.ready, true);
  assert.equal(supported.unsupported_count, 0);
  assertChangelogClaims(supported);
  const multi = { ...base, tests: [{ command: receipt.command }, { command: "second test" }] };
  assert.equal(auditChangelogClaims({ items: [multi] }, [receipt]).ready, false);
  assert.equal(auditChangelogClaims({ items: [multi] }, [receipt, { ...receipt, command: "second test" }]).ready, true);
  const unrelated = { ...receipt, command: "other test" };
  assert.equal(auditChangelogClaims({ items: [base] }, [unrelated, receipt]).ready, true);
  assert.equal(auditChangelogClaims({ items: [base] }, [unrelated]).ready, false);
  assert.equal(auditChangelogClaims({ items: [base] }, [receipt, { ...receipt, outcome: "failed" }]).ready, false);
  assert.equal(auditChangelogClaims({ items: [base] }, [{ ...receipt, item: "foreign" }]).ready, false);
});

test("repair assertions cannot be inferred from Fixed wording alone", () => {
  const item: PmItem = { id: "fixture-task", title: "Fix failure", type: "Task", status: "closed", tags: ["shipping"], breaking: true };
  const conventional = auditChangelogClaims({ items: [item], conventional: true });
  assert.equal(conventional.claims[0].section, "Bug Fixes");
  assert.ok(conventional.claims[0].gaps.includes("repair"));
  for (const rendering of [{}, { conventional: true }, { sectionBy: "type" as const }, { sectionBy: "label" as const }, { sectionBy: "status" as const }]) {
    const options = { items: [item], breakingChanges: true, ...rendering };
    const report = auditChangelogClaims(options);
    assert.equal(report.claim_count, 2);
    for (const claim of report.claims) assert.ok(claim.gaps.includes("repair"), `Missing repair gap in ${claim.section}`);
    assert.ok(report.claims.some((claim) => claim.section === (rendering.conventional ? "Bug Fixes" : rendering.sectionBy === "type" ? "Task" : rendering.sectionBy === "label" ? "shipping" : rendering.sectionBy === "status" ? "Closed" : "Fixed")));
    assert.throws(() => assertChangelogClaims(report), /unsupported_claims/);
    const supported = auditChangelogClaims({ ...options, items: [{ ...item, close_reason: "Fixed failure; merged PR #12", tests: base.tests }] }, [{ ...receipt, item: item.id! }]);
    assert.equal(supported.ready, true);
  }
});

test("claim source categories follow the classifier rather than arbitrary group headings", () => {
  const item: PmItem = { id: "fixture-group", title: "Security hardening", type: "Fixed", status: "closed" };
  const options = { items: [item], sectionBy: "type" as const };
  const categories: Array<string | undefined> = [];
  createChangelog(options, (source) => { categories.push(source.category); });
  assert.deepEqual(categories, ["Security"]);
  const report = auditChangelogClaims(options);
  assert.equal(report.claims[0].section, "Fixed");
  assert.equal(report.claims[0].gaps.includes("repair"), false);
});

test("delivery evidence is affirmative; malformed rows remain gaps", () => {
  const links = [null, 4, {}, "merged PR #42", "PR #7", { state: "merged", relation: "delivered", url: "https://github.com/example/project/pull/4" }, { state: "unmerged", url: "https://github.com/example/project/pull/5" }];
  const item = { ...base, close_reason: "Fixed parser", actual_result: "Shipped commit abcdef0", files: [null, false, {}, { path: "src/parser.ts" }, { path: " " }], tests: [null, 4, {}, { command: receipt.command }, { path: "test/parser.test.ts" }], links };
  const report = auditChangelogClaims({ items: [item] }, [receipt, { ...receipt, command: "test/parser.test.ts" }]);
  assert.equal(report.ready, true);
  assert.deepEqual(report.evidence[0].files, ["src/parser.ts"]);
  assert.equal(report.evidence[0].delivery.length, 3);
  assert.equal(auditChangelogClaims({ items: [{ ...item, links: {}, actual_result: undefined }] }).claims[0].gaps.includes("delivery"), true);
  assert.equal(auditChangelogClaims({ items: [{ ...item, tests: undefined }] }).claims[0].gaps.includes("tests"), true);
});

test("repeated claims share canonical evidence and regeneration ignores evidence input order", () => {
  const other = { ...base, id: "fixture-z", title: base.title, breaking: true, tags: ["one", "two"], assignee: "fixture-contributor" };
  const options = { items: [other, base], sectionBy: "label" as const, breakingChanges: true, contributors: true, includeMetadata: true, bodyPreview: 12 };
  const records = [receipt, { ...receipt, reference: "https://example.com/ci/1" }, { ...receipt, item: other.id }];
  const first = auditChangelogClaims(options, records);
  const second = auditChangelogClaims({ ...options, items: [base, other] }, [...records].reverse());
  assert.deepEqual(first, second);
  assert.equal(first.evidence.length, 2);
  assert.ok(first.claims.some((row) => row.section === "Breaking Changes"));
  assert.ok(first.claims.some((row) => row.section === "Contributors" && row.gaps.length === 0));
  const lines = createChangelog(options).markdown.split("\n");
  for (const row of first.claims) assert.equal(row.claim, lines[row.line - 1]);
  assert.equal(formatClaimAudit(first, "json"), JSON.stringify(first) + "\n");
  assert.match(formatClaimAudit(first, "toon"), /claims\[\d+\]\{line,release,section,claim,items,gaps\}:/);
  assert.equal(first.evidence[0].test_receipts.length, 2);
  const missingCredits = auditChangelogClaims({ items: [base], contributors: true });
  assert.equal(missingCredits.claim_count, 1);
});

test("identity and malformed receipt refusals carry recovery guidance", () => {
  for (const items of [[{ ...base, id: undefined }], [base, base], [{ ...base, id: " " }]]) {
    assert.throws(() => auditChangelogClaims({ items }), (error: unknown) => error instanceof ClaimAuditError && error.code === "ambiguous_items" && !!error.remedy);
  }
  for (const value of ["{broken", "null", null, {}, [null], [false], [{}], [{ ...receipt, outcome: "unknown" }], [{ ...receipt, command: " " }]]) {
    assert.throws(() => parseClaimTestReceipts(value), (error: unknown) => error instanceof ClaimAuditError && error.code === "invalid_receipts");
  }
  assert.deepEqual(parseClaimTestReceipts([]), []);
  assert.deepEqual(parseClaimTestReceipts(JSON.stringify([receipt])), [receipt]);
  assert.throws(() => auditChangelogClaims({ items: [], dependencyUpdates: true }), (error: unknown) => error instanceof ClaimAuditError && error.code === "git_required");
});

test("empty selections and empty release assertions have deterministic zero-gap reports", () => {
  const empty = auditChangelogClaims({ items: [], includeEmpty: true });
  assert.equal(empty.claims[0].claim, "No changes.");
  assertChangelogClaims(empty);
  assert.equal(auditChangelogClaims({ items: [] }).claim_count, 0);
  const window = auditChangelogClaims({ items: [], includeEmpty: true, releaseWindows: [{ heading: "1.0.0", until: "2026-10-21" }] });
  assert.equal(window.ready, true);
});

test("real non-git tracker works through SDK, standalone and host CLI with git absent", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-claims-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, PM_PATH: join(cwd, ".agents/pm"), PM_GLOBAL_PATH: join(cwd, "global"), PM_AUTHOR: "fixture-agent", DO_NOT_TRACK: "1", GIT_CEILING_DIRECTORIES: dirname(cwd), PATH: "" };
  const pm = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const pmRoot = join(cwd, ".agents/pm");
  const init = spawnSync(process.execPath, [pm, "init", "--yes", "--agent-guidance", "skip", "--no-merge-fence"], { cwd, env, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const created = await runCreate({ title: base.title, type: "Issue", status: "closed", closeReason: base.close_reason, test: [`command=${receipt.command},scope=project`], createMode: "progressive" }, { path: pmRoot });
  assert.throws(() => auditChangelogClaims({ items: [], dependencyUpdates: true, gitCwd: cwd }), (error: unknown) => error instanceof ClaimAuditError && error.code === "git_required");
  const receiptsFile = join(cwd, "receipts.json");
  writeFileSync(receiptsFile, JSON.stringify([{ ...receipt, item: created.item.id }]));
  const cli = resolve("dist/cli.js");
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });
  const good = run(["audit", "--pm-root", pmRoot, "--audit-receipts", receiptsFile, "--json", "--check"]);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).ready, true);
  const gap = run(["--audit-evidence", "--pm-root", pmRoot, "--check", "--format", "json"]);
  assert.equal(gap.status, 1);
  assert.match(gap.stderr, /unsupported_claims/);
  assert.equal(JSON.parse(gap.stdout).unsupported_count, 1);
  assert.match(run(["audit", "--pm-root", pmRoot]).stdout, /ready: false/);
  const dependencyRefusal = run(["audit", "--pm-root", pmRoot, "--dependency-updates"]);
  assert.notEqual(dependencyRefusal.status, 0);
  assert.match(dependencyRefusal.stderr, /git_required:.*needs a git repository/);
  const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] });
  assert.deepEqual(activation.failed, []);
  const host = await runRegisteredCommandForTest(activation.commands, { command: "changelog audit", pmRoot, options: { format: "json", "audit-receipts": receiptsFile, check: true } });
  assert.equal(host.handled, true);
  const result = host.result as { output: string };
  assert.equal(JSON.parse(result.output).ready, true);
  await assert.rejects(() => runRegisteredCommandForTest(activation.commands, { command: "changelog audit", pmRoot, options: { check: true } }), /unsupported_claims/);
  const hostJson = await runRegisteredCommandForTest(activation.commands, { command: "changelog audit", pmRoot });
  assert.equal(JSON.parse((hostJson.result as { output: string }).output).unsupported_count, 1);
  const toon = await runRegisteredCommandForTest(activation.commands, { command: "changelog audit", pmRoot, global: { json: false } });
  assert.match((toon.result as { output: string }).output, /ready: false/);
  // Load the actual extension through the host executable, not only its test dispatcher.
  const extensionRoot = join(pmRoot, "extensions/pm-changelog");
  mkdirSync(extensionRoot, { recursive: true });
  cpSync(resolve("dist"), join(extensionRoot, "dist"), { recursive: true });
  cpSync(resolve("manifest.json"), join(extensionRoot, "manifest.json"));
  writeFileSync(join(extensionRoot, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(resolve("node_modules"), join(extensionRoot, "node_modules"), "junction");
  const actual = spawnSync(process.execPath, [pm, "--path", pmRoot, "changelog", "audit", "--format", "json"], { cwd, env, encoding: "utf8" });
  assert.equal(actual.status, 0, actual.stderr);
  assert.equal(JSON.parse(actual.stdout).unsupported_count, 1);
  const actualGap = spawnSync(process.execPath, [pm, "--path", pmRoot, "changelog", "audit", "--check"], { cwd, env, encoding: "utf8" });
  assert.notEqual(actualGap.status, 0, actualGap.stderr);
  assert.match(actualGap.stderr, /unsupported_claims/);
  assert.equal(readFileSync(receiptsFile, "utf8"), JSON.stringify([{ ...receipt, item: created.item.id }]));
});


test("dependency and empty prose lines retain source gaps and line positions", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-claims-git-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  initGitFixture(cwd);
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-m", "build(deps): bump fixture from 1 to 2 (#42)"], { cwd, stdio: "pipe" });
  const options = { items: [], dependencyUpdates: true, gitCwd: cwd };
  const report = auditChangelogClaims(options);
  assert.equal(report.claim_count, 1);
  assert.deepEqual(report.claims[0].gaps, ["dependency"]);
  assert.equal(report.evidence.length, 0);
  assert.match(formatClaimAudit(report, "toon"), /evidence\[0\]:/);
  assert.equal(report.claims[0].claim, createChangelog(options).markdown.split("\n")[report.claims[0].line - 1]);
  const sorted = auditChangelogClaims({ items: [{ ...base, title: "Z" }, { ...base, id: "fixture-z", title: "A" }] });
  assert.deepEqual(sorted.evidence.map((row) => row.item), ["fixture-a", "fixture-z"]);
  assert.deepEqual(auditChangelogClaims({ items: [base, { ...base, id: "fixture-z", title: "Z" }] }).evidence.map((row) => row.item), ["fixture-a", "fixture-z"]);
});


test("deterministic tie ordering is independent of tracker enumeration", () => {
  const other = { ...base, id: "fixture-z" };
  const a = auditChangelogClaims({ items: [other, base] });
  const b = auditChangelogClaims({ items: [base, other] });
  assert.deepEqual(a, b);
  assert.deepEqual(a.claims.map((row) => row.items[0]), ["fixture-a", "fixture-z"]);
});


test("in-process CLI audit preserves reports and refuses unsupported publication", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-claims-cli-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const input = join(cwd, "items.json");
  const receipts = join(cwd, "receipts.json");
  writeFileSync(input, JSON.stringify([base]));
  writeFileSync(receipts, JSON.stringify([receipt]));
  const writes: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
  await cliTestSurface.main(["audit", "--input", input, "--audit-receipts", receipts, "--json", "--check"]);
  assert.equal(JSON.parse(writes.pop()!).ready, true);
  await cliTestSurface.main(["--audit-evidence", "--input", input, "--format", "json"]);
  assert.equal(JSON.parse(writes.pop()!).ready, false);
  await cliTestSurface.main(["audit", "--input", input]);
  assert.match(writes.pop()!, /ready: false/);
  await assert.rejects(() => cliTestSurface.main(["audit", "--input", input, "--check"]), /unsupported_claims/);
  assert.match(writes.pop()!, /test_result/);
});
