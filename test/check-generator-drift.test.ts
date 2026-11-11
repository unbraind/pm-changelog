import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { listAllComplete, PmCliError, runCreate, runInit } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import { readConsumerUpgrades } from "../src/consumer-upgrades.ts";
import { mergeChangelog, PREVIOUS_RENDERING_VERSION, RENDERING_VERSION, writeChangelog } from "../src/generator.ts";
import { classifyCheckDrift, regenerationCommand } from "../src/check-drift.ts";
import { cliTestSurface } from "../src/cli.ts";
import extension from "../src/extension.ts";
import { fixtureEnvironment, initGitFixture } from "./git-fixture.ts";

const CLI = resolve("src/cli.ts");
const PM = resolve("node_modules/.bin/pm");

/** Build a genuine plain-directory tracker and drive the production CLI. */
async function fixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pm-check-rendering-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const pmRoot = join(cwd, ".agents/pm");
  await runInit("check", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  const add = async (id: string) => runCreate({ id, title: `Delivered ${id}`, type: "Task", status: "closed",
    closeReason: "Implemented the documented change", completedAt: "2026-11-01T00:00:00.000Z", createMode: "progressive" }, { path: pmRoot });
  await add("check-alpha");
  await add("check-beta");
  const output = join(cwd, "CHANGELOG.md");
  const args = ["--pm-root", pmRoot, "--pm-bin", PM, "--version", "1.2.0", "--date", "2026-11-01", "--output", "CHANGELOG.md"];
  const run = (extra: string[] = []) => spawnSync(process.execPath, [CLI, ...args, ...extra], { cwd, encoding: "utf8" });
  assert.equal(run().status, 0);
  return { cwd, pmRoot, output, args, run, add };
}

test("real non-git tracker: reorder_only names an executable regeneration command and still exits 1", async (t) => {
  const f = await fixture(t);
  const current = readFileSync(f.output, "utf8");
  const entries = current.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(entries.length, 2);
  const committed = current.replace(entries.join("\n"), [...entries].reverse().join("\n"));
  writeFileSync(f.output, committed);
  const result = f.run(["--check"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Drift classification: reorder_only/);
  assert.match(result.stderr, /this is a one-time regeneration after a pm-changelog upgrade/);
  const json = f.run(["--check", "--json"]);
  assert.equal(json.status, 1);
  const receipt = JSON.parse(json.stdout);
  assert.equal(receipt.classification, "reorder_only");
  assert.equal(receipt.rendering_version, RENDERING_VERSION);
  assert.equal(receipt.previous_rendering_version, PREVIOUS_RENDERING_VERSION);
  assert.ok(receipt.regeneration_command.includes("--pm-bin"));
  assert.ok(receipt.regeneration_command.includes("--version 1.2.0 --date 2026-11-01"));
  assert.ok(!receipt.regeneration_command.includes("--check"));
  assert.equal(readFileSync(f.output, "utf8"), committed, "check never writes");
  const regenerated = spawnSync(receipt.regeneration_command, { cwd: f.cwd, shell: true, encoding: "utf8" });
  assert.equal(regenerated.status, 0, regenerated.stderr);
  assert.equal(readFileSync(f.output, "utf8"), current);
  assert.equal(f.run(["--check"]).status, 0);
});

test("real non-git tracker: a new item is tracker_changed and still exits 1", async (t) => {
  const f = await fixture(t);
  await f.add("check-new");
  const text = f.run(["--check"]);
  assert.equal(text.status, 1);
  assert.match(text.stderr, /Drift classification: tracker_changed/);
  assert.doesNotMatch(text.stderr, /one-time regeneration/);
  const json = f.run(["--check", "--json"]);
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).classification, "tracker_changed");
  assert.equal(JSON.parse(json.stdout).regeneration_command, undefined);
});

test("same real tracker: exact previous prepend rendering is rendering_changed, even with --no-check-diff", async (t) => {
  const f = await fixture(t);
  const generated = readFileSync(f.output, "utf8");
  writeFileSync(f.output, generated.replace("# Changelog\n", "# Changelog\n\n## Unreleased\n\nNo changes.\n"));
  const text = f.run(["--mode", "prepend", "--check", "--no-check-diff"]);
  assert.equal(text.status, 1);
  assert.match(text.stderr, /Drift classification: rendering_changed/);
  assert.ok(text.stderr.includes(`rendering changed in ${RENDERING_VERSION}`));
  assert.match(text.stderr, /--mode prepend --no-check-diff/);
  assert.doesNotMatch(text.stderr, /^@@/m);
  const json = f.run(["--mode", "prepend", "--check", "--json"]);
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).classification, "rendering_changed");
  // The same previous profile must not hide actual tracker changes.
  await f.add("check-new");
  assert.equal(JSON.parse(f.run(["--mode", "prepend", "--check", "--json"]).stdout).classification, "tracker_changed");
});

test("reorder classification preserves section membership, duplicates, prose and code", () => {
  const document = "# Changelog\n\n## 1.0.0\n\n### Changed\n\n- Alpha\n- Beta\n";
  for (const changed of [document.replace("### Changed", "### Fixed"), document.replace("- Beta", "- Alpha"),
    document.replace("- Beta", "- Gamma"), document + "Extra prose\n", document.replace("- Beta", "### Fixed\n\n- Beta")]) {
    assert.equal(classifyCheckDrift(document, changed, () => "previous"), "tracker_changed");
  }
  const code = "```md\n- Alpha\n- Beta\n```\n";
  assert.equal(classifyCheckDrift(code, code.replace("- Alpha\n- Beta", "- Beta\n- Alpha"), () => "previous"), "tracker_changed");
  for (const entries of ["- Alpha\n\n- Beta\n", "- Alpha\n  Details A\n- Beta\n  Details B\n"]) {
    const swapped = entries.startsWith("- Alpha\n\n") ? "- Beta\n\n- Alpha\n" : "- Beta\n  Details B\n- Alpha\n  Details A\n";
    assert.equal(classifyCheckDrift(document.replace("- Alpha\n- Beta\n", entries), document.replace("- Alpha\n- Beta\n", swapped), () => "previous"), "reorder_only");
  }
  assert.equal(classifyCheckDrift("~~~md\n- A\n- B\n~~~\n", "~~~md\n- B\n- A\n~~~\n", () => "previous"), "tracker_changed");
  assert.equal(classifyCheckDrift("- A\n- B\n", "- B\n- A\n", () => { throw new Error("reorder must be lazy"); }), "reorder_only");
  assert.equal(classifyCheckDrift("- A\n- B", "- B\n- A", () => "previous"), "reorder_only");
  const nestedFence = "````md\n~~~\n```\n```` trailing text\n- A\n- B\n````\n";
  assert.equal(classifyCheckDrift(nestedFence, nestedFence.replace("- A\n- B", "- B\n- A"), () => "previous"), "tracker_changed");
  assert.equal(classifyCheckDrift("same", "same", () => "previous"), "tracker_changed");
});

test("previous rendering shares merge logic while retaining published whitespace and heading rules", () => {
  const versioned = "## 1.0.0\n\n- Delivered\n";
  const legacy = (existing: string | undefined, generated = versioned) => mergeChangelog(existing, generated, {}, PREVIOUS_RENDERING_VERSION).markdown;
  assert.equal(legacy(undefined), versioned);
  assert.equal(legacy("# Changelog\n\nIntro  \n"), "# Changelog\n\n" + versioned + "\nIntro\n");
  assert.equal(legacy("# Changelog\n\n"), "# Changelog\n\n" + versioned);
  assert.equal(legacy("# Changelog\n\n## Unreleased\n\n- Pending\n"), "# Changelog\n\n" + versioned);
  assert.equal(legacy("# Changelog\n\n## Unreleased\n\nNo changes.\n", "# Changelog\n"), "# Changelog\n\n## Unreleased\n\nNo changes.\n");
  assert.equal(legacy("Legacy text\n"), "# Changelog\n\n" + versioned + "\nLegacy text\n");
});

test("in-process checks expose all three diagnoses on the same real tracker", async (t) => {
  const f = await fixture(t);
  const original = readFileSync(f.output, "utf8");
  const entries = original.split("\n").filter((line) => line.startsWith("- "));
  const stdout = process.stdout.write, stderr = process.stderr.write, exitCode = process.exitCode;
  let captured = "";
  process.stdout.write = ((chunk: string | Uint8Array) => { captured += chunk.toString(); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    const check = async (extra: string[] = []) => {
      captured = "";
      await cliTestSurface.main([...f.args, "--output", f.output, "--check", "--json", "--no-check-diff", ...extra]);
      assert.equal(process.exitCode, 1);
      return JSON.parse(captured);
    };
    writeFileSync(f.output, original.replace(entries.join("\n"), [...entries].reverse().join("\n")));
    const reorder = await check();
    assert.equal(reorder.classification, "reorder_only");
    assert.match(reorder.regeneration_command, /^pm-changelog /);
    writeFileSync(f.output, original.replace("# Changelog\n", "# Changelog\n\n## Unreleased\n\nNo changes.\n"));
    assert.equal((await check(["--mode", "prepend"])).classification, "rendering_changed");
    await f.add("check-new");
    assert.equal((await check()).classification, "tracker_changed");
  } finally {
    process.stdout.write = stdout; process.stderr.write = stderr; process.exitCode = exitCode;
  }
});

test("package tracker catalog publishes the 2026.11.7 one-time regeneration obligation", async () => {
  const report = await readConsumerUpgrades(resolve(".agents/pm"), { audience: "operator", from: "2026.11.6", to: "2026.11.7" });
  const action = report.steps.find((step) => step.id === "regenerate-changelog-2026-11-7");
  assert.ok(action);
  assert.equal(action.title, "regenerate CHANGELOG.md once");
  assert.deepEqual(action.attribution, [{ item: "pmc-total-item-order", release: "2026.11.7" }]);
});

test("configured wrapper commands preserve quoting and option values named --check", () => {
  const argv = process.argv;
  try {
    process.argv = [process.execPath, resolve("scripts/generate notes's.ts"), "--title", "--check", "--check"];
    assert.equal(regenerationCommand([], new Set(["--title"])), "node 'scripts/generate notes'\\''s.ts' --title --check");
    process.argv = [process.execPath];
    assert.equal(regenerationCommand(["--check"], new Set()), "pm-changelog");
    assert.equal(regenerationCommand(["--title"], new Set(["--title"]), ["pm", "changelog", "generate"]), "pm changelog generate --title");
  } finally { process.argv = argv; }
});

test("registered generate checks share diagnoses, remedies and nonzero typed receipts on a real tracker", async (t) => {
  const f = await fixture(t);
  const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] });
  assert.deepEqual(activation.failed, []);
  const options = { output: f.output, "release-version": "1.2.0", date: "2026-11-01", contributors: false, "emoji-prefix": undefined };
  const run = (extra = {}) => runRegisteredCommandForTest(activation.commands, { command: "changelog generate", options: { ...options, ...extra }, pmRoot: f.pmRoot });
  await run();
  const current = readFileSync(f.output, "utf8");
  const entries = current.split("\n").filter((line) => line.startsWith("- "));
  writeFileSync(f.output, current.replace(entries.join("\n"), [...entries].reverse().join("\n")));
  await assert.rejects(() => run({ check: true }), (error: unknown) => {
    assert.ok(error instanceof PmCliError);
    assert.equal(error.exitCode, 1);
    assert.equal(error.code, "reorder_only");
    assert.match(error.message, /this is a one-time regeneration after a pm-changelog upgrade/);
    assert.match(error.context.required!, /^pm --path /);
    assert.ok(error.context.required!.includes(f.pmRoot));
    assert.ok(error.context.required!.includes("changelog generate"));
    return true;
  });
  writeFileSync(f.output, current.replace("# Changelog\n", "# Changelog\n\n## Unreleased\n\nNo changes.\n"));
  await assert.rejects(() => run({ check: true, mode: "prepend" }), (error: unknown) => error instanceof PmCliError && error.code === "rendering_changed" && error.exitCode === 1);
  await f.add("check-new");
  await assert.rejects(() => run({ check: true }), (error: unknown) => error instanceof PmCliError && error.code === "tracker_changed" && error.context.required === undefined && error.exitCode === 1);
  rmSync(f.output);
  await assert.rejects(() => run({ check: true }), (error: unknown) => error instanceof PmCliError && error.code === "tracker_changed" && error.exitCode === 1);
});

test("previous dependency selection uses previous heading rules on the same real tracker and Git snapshot", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-rendering-tag-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const pmRoot = join(cwd, ".agents/pm");
  await runInit("render", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  initGitFixture(cwd);
  const output = join(cwd, "CHANGELOG.md");
  writeFileSync(output, "# Changelog\n\n```md\n## 1.0.0\n```\n");
  const env = { ...fixtureEnvironment(), GIT_AUTHOR_DATE: "2026-11-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-11-01T00:00:00Z" };
  for (const args of [["add", "CHANGELOG.md"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "chore(deps): bump fixture from 1.0.0 to 1.1.0 (#1)"], ["tag", "v1.0.0"]]) {
    execFileSync("git", args, { cwd, env, stdio: "pipe" });
  }
  const options = { items: (await listAllComplete({}, { pmRoot })).items, gitCwd: cwd, output, check: true,
    releaseWindows: [{ heading: "1.0.0 - 2026-11-01", releaseTag: "v1.0.0", until: "2026-11-01T23:59:59Z" }] };
  const current = writeChangelog(options).markdown;
  const previous = writeChangelog(options, PREVIOUS_RENDERING_VERSION).markdown;
  assert.equal(current, "# Changelog\n");
  assert.match(previous, /### Dependencies\n\n- Bump fixture/);
  writeFileSync(output, previous);
  assert.equal(classifyCheckDrift(previous, current, () => writeChangelog(options, PREVIOUS_RENDERING_VERSION).markdown), "rendering_changed");
  await runCreate({ id: "render-new", title: "Delivered new item", type: "Task", status: "closed", closeReason: "Implemented new item",
    completedAt: "2026-11-01T00:00:00Z", createMode: "progressive" }, { path: pmRoot });
  options.items = (await listAllComplete({}, { pmRoot })).items;
  assert.equal(classifyCheckDrift(previous, writeChangelog(options).markdown, () => writeChangelog(options, PREVIOUS_RENDERING_VERSION).markdown), "tracker_changed");
});
