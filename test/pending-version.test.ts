import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { PmClient, runCreate, runInit } from "@unbrained/pm-cli/sdk";
import { cliTestSurface } from "../src/cli.ts";
import { assertRequestedRelease, createChangelog, MissingRequestedReleaseError } from "../src/generator.ts";
import type { GenerateChangelogOptions, PmItem } from "../src/types.ts";

test("seeded release histories emit the requested heading or fail before rendering", () => {
  let seed = 0x10292026;
  const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 8; };
  let passed = 0, refused = 0;
  for (let iteration = 0; iteration < 500; iteration++) {
    const version = `2026.10.${10 + random() % 20}`;
    const items: PmItem[] = Array.from({ length: random() % 15 }, (_, index) => ({
      id: `case-${index}`, title: `Change ${index}`, type: "Task",
      status: random() % 3 === 0 ? "open" : "closed",
      release: random() % 2 ? version : "2026.9.1", closed_at: "2026-10-29T00:00:00Z",
    }));
    const options: GenerateChangelogOptions = {
      items, version, includeEmpty: random() % 4 === 0, limit: 1,
      releaseWindows: [
        { heading: `${version} - 2026-10-29`, since: "2026-10-01T00:00:00Z" },
        { heading: "2026.9.1 - 2026-09-01", until: "2026-10-01T00:00:00Z" },
      ],
    };
    try {
      assertRequestedRelease(options);
      assert.equal(createChangelog(options).markdown.match(/^## (\S+)/m)?.[1], version);
      passed++;
    } catch (error) {
      assert.ok(error instanceof MissingRequestedReleaseError);
      assert.equal(error.code, "MISSING_REQUESTED_RELEASE");
      assert.equal(error.version, version);
      assert.equal(items.some((item) => item.status === "closed" && item.release === version) || options.includeEmpty, false);
      refused++;
    }
  }
  assert.doesNotThrow(() => assertRequestedRelease({ items: [] }));
  assert.doesNotThrow(() => assertRequestedRelease({ version: "Unreleased", items: [{ title: "Delivered", status: "closed" }] }));
  assert.ok(passed > 0 && refused > 0);
});

test("all CLI output modes refuse an absent requested release before side effects", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "pm-requested-release-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const input = join(scratch, "input.json"), output = join(scratch, "CHANGELOG.md");
  writeFileSync(input, JSON.stringify({ items: [
    { id: "old", title: "Already shipped", status: "closed", type: "Task", release: "2026.10.28" },
    { id: "open", title: "Not delivered", status: "open", type: "Task" },
  ] }));
  writeFileSync(output, "sentinel\n");
  const writes: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
  for (const mode of [[], ["--stdout", "--limit", "1"], ["--json"], ["--changelog-json"], ["--format", "json"], ["--summary"], ["--summary", "--format", "json"], ["--suggest-semver"], ["--audit-evidence"], ["--check"], ["--mode", "prepend"], ["--github-output", "--github-step-summary"], ["--check-links"]]) {
    await assert.rejects(cliTestSurface.main(["--input", input, "--version", "2026.10.29", "--respect-item-release", "--output", output, ...mode]), (error: unknown) => {
      assert.ok(error instanceof MissingRequestedReleaseError);
      assert.equal(error.report.excluded_counts.status, 1);
      assert.match(error.message, /2026\.10\.29/);
      assert.match(error.remedy, /pm update/);
      const diagnostic = cliTestSurface.errorMessage(error);
      assert.doesNotMatch(diagnostic, /Not delivered|Already shipped/);
      const formatted = JSON.parse(diagnostic);
      assert.equal(formatted.error.code, error.code);
      return true;
    });
    assert.equal(readFileSync(output, "utf8"), "sentinel\n");
    assert.deepEqual(writes, []);
  }
  await cliTestSurface.main(["--input", input, "--version", "2026.10.29", "--respect-item-release", "--stdout", "--include-empty", "--date-from-version"]);
  assert.match(writes.join(""), /## 2026\.10\.29 - 2026-10-29\n\nNo changes\./);
});

test("--no-pending-release without --all-release-tags still refuses a missing requested release", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "pm-requested-release-optout-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const input = join(scratch, "input.json"), output = join(scratch, "CHANGELOG.md");
  writeFileSync(input, JSON.stringify({ items: [{ id: "old", title: "Already shipped", status: "closed", type: "Task", release: "1" }] }));
  writeFileSync(output, "# Changelog\n\n## 1 - 2026-10-01\n\nsentinel\n");
  // Single-version mode has no pending window to suppress, so replace mode must not rewrite the file to its title.
  await assert.rejects(cliTestSurface.main(["--input", input, "--version", "2", "--respect-item-release", "--no-pending-release", "--output", output]),
    (error: unknown) => error instanceof MissingRequestedReleaseError && error.version === "2");
  assert.equal(readFileSync(output, "utf8"), "# Changelog\n\n## 1 - 2026-10-01\n\nsentinel\n");
});

test("real non-git tracker permits delivered unassigned work and diagnoses still-open work", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "pm-release-nogit-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const pmRoot = join(scratch, ".agents/pm");
  await runInit("release-fixture", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  await runCreate({ id: "release-open", title: "Fix delivery", type: "Task", createMode: "progressive", unset: ["parent", "release", "goal", "sprint", "objective"] }, { path: pmRoot, author: "release-test" });
  const bin = join(scratch, "bin"); mkdirSync(bin);
  const childEnv = { PATH: bin, HOME: scratch, PM_AUTHOR: "release-test", PM_GLOBAL_PATH: join(scratch, "global"), GIT_CEILING_DIRECTORIES: dirname(scratch), DO_NOT_TRACK: "1" };
  const run = (): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [resolve("src/cli.ts"), "--pm-root", pmRoot, "--version", "2026.10.29", "--respect-item-release", "--stdout", "--date-from-version"], { cwd: scratch, env: childEnv, encoding: "utf8" });
  const refused = run();
  assert.equal(refused.status, 1, String(refused.stderr));
  assert.equal(String(refused.stdout), "");
  assert.equal(JSON.parse(String(refused.stderr)).error.selection_report.excluded_counts.status, 1);
  await new PmClient({ pmRoot, author: "release-test" }).update("release-open", { status: "closed", closeReason: "Completed" });
  const accepted = run();
  assert.equal(accepted.status, 0, String(accepted.stderr));
  assert.match(String(accepted.stdout), /## 2026\.10\.29 - 2026-10-29/);
  assert.match(String(accepted.stdout), /Fix delivery/);
});

test("pending --stdout --limit 1 never substitutes the latest existing Git release", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "pm-release-history-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "2026-10-28T12:00:00Z", GIT_COMMITTER_DATE: "2026-10-28T12:00:00Z" };
  for (const args of [["init"], ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"], ["tag", "v2026.10.28"]]) {
    const result = spawnSync("git", args, { cwd: scratch, env: gitEnv, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const input = join(scratch, "items.json");
  writeFileSync(input, JSON.stringify({ items: [{ id: "old", title: "Old delivery", status: "closed", type: "Task", release: "2026.10.28", closed_at: "2026-10-28T10:00:00Z" }] }));
  const args = [resolve("src/cli.ts"), "--input", input, "--all-release-tags", "--version", "2026.10.29", "--date-from-version", "--stdout", "--limit", "1"];
  const refused = spawnSync(process.execPath, args, { cwd: scratch, env: gitEnv, encoding: "utf8" });
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(refused.stdout, "");
  assert.equal(JSON.parse(refused.stderr).error.code, "MISSING_REQUESTED_RELEASE");
  const explicitEmpty = spawnSync(process.execPath, [...args, "--include-empty"], { cwd: scratch, env: gitEnv, encoding: "utf8" });
  assert.equal(explicitEmpty.status, 0, explicitEmpty.stderr);
  assert.match(explicitEmpty.stdout, /^## 2026\.10\.29 - 2026-10-29$/m);
  assert.doesNotMatch(explicitEmpty.stdout, /^## 2026\.10\.28/m);
  const historical = spawnSync(process.execPath, [...args, "--no-pending-release"], { cwd: scratch, env: gitEnv, encoding: "utf8" });
  assert.equal(historical.status, 0, historical.stderr);
  assert.match(historical.stdout, /^## 2026\.10\.28/m);
});

test("500 random item histories satisfy the requested-heading-or-command-failure property", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "pm-release-property-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const input = join(scratch, "history.json");
  let seed = 0x291029, output = "", passed = 0, refused = 0;
  const random = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed >>> 8; };
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { output += String(chunk); return true; });
  for (let iteration = 0; iteration < 500; iteration++) {
    const version = `7.${random() % 100}.0`;
    const items = Array.from({ length: random() % 10 }, (_, index) => ({ id: `change-${index}`, title: `History ${index}`, type: "Task", status: random() % 3 === 0 ? "open" : "closed", release: random() % 2 ? version : "6.0.0" }));
    writeFileSync(input, JSON.stringify({ items })); output = "";
    try {
      await cliTestSurface.main(["--input", input, "--version", version, "--date", "2026-10-29", "--respect-item-release", "--stdout", "--limit", "1"]);
      assert.equal(output.match(/^## (\S+)/m)?.[1], version); passed++;
    } catch (error) {
      assert.ok(error instanceof MissingRequestedReleaseError);
      assert.equal(output, ""); refused++;
    }
  }
  assert.ok(passed > 0 && refused > 0);
});
