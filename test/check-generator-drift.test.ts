import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { listAllComplete, PmCliError, runCreate, runInit, runUpdate } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import { readConsumerUpgrades } from "../src/consumer-upgrades.ts";
import { mergeChangelog, PREVIOUS_RENDERING_VERSION, RENDERING_VERSION, writeChangelog } from "../src/generator.ts";
import { classifyCheckDrift as classify, regenerationCommand, canonicalRegenerationOptions, isEntryReorder } from "../src/check-drift.ts";
import { cliTestSurface } from "../src/cli.ts";
import extension from "../src/extension.ts";
import { fixtureEnvironment, initGitFixture } from "./git-fixture.ts";

/** Compare explicitly different declared renderer revisions in shared unit cases. */
const classifyCheckDrift = (committed: string, generated: string, previous: () => string) => classify(committed, generated, previous, { current: RENDERING_VERSION, previous: PREVIOUS_RENDERING_VERSION });

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

test("real non-git tracker: a current-rendering reorder is tracker_changed and still exits 1", async (t) => {
  const f = await fixture(t);
  const current = readFileSync(f.output, "utf8");
  const entries = current.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(entries.length, 2);
  const committed = current.replace(entries.join("\n"), [...entries].reverse().join("\n"));
  writeFileSync(f.output, committed);
  const result = f.run(["--check"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Drift classification: tracker_changed/);
  assert.match(result.stderr, /completed_at edit or manual reorder/);
  assert.doesNotMatch(result.stderr, /one-time regeneration/);
  const json = f.run(["--check", "--json"]);
  assert.equal(json.status, 1);
  const receipt = JSON.parse(json.stdout);
  assert.equal(receipt.classification, "tracker_changed");
  assert.equal(receipt.rendering_version, RENDERING_VERSION);
  assert.equal(receipt.previous_rendering_version, PREVIOUS_RENDERING_VERSION);
  assert.equal(receipt.regeneration_command, undefined);
  assert.equal(readFileSync(f.output, "utf8"), committed, "check never writes");
  writeFileSync(f.output, current.replace("# Changelog\n", "# Changelog\n\n## Unreleased\n\nNo changes.\n"));
  const upgrade = f.run(["--check", "--mode", "prepend", "--json"]);
  assert.equal(upgrade.status, 1);
  const guidance = JSON.parse(upgrade.stdout);
  assert.equal(guidance.classification, "rendering_changed");
  assert.ok(guidance.regeneration_argv.includes("--version=1.2.0"));
  assert.ok(!guidance.regeneration_argv.includes("--check"));
  assert.match(guidance.message, /this is a one-time regeneration after a pm-changelog upgrade/);
  const regenerated = spawnSync(guidance.regeneration_command, { cwd: f.cwd, shell: true, encoding: "utf8" });
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
  assert.match(text.stderr, /--mode=prepend.*--no-check-diff/);
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
    assert.equal(classifyCheckDrift(document.replace("- Alpha\n- Beta\n", entries), document.replace("- Alpha\n- Beta\n", swapped), () => document.replace("- Alpha\n- Beta\n", entries)), "reorder_only");
  }
  assert.equal(classifyCheckDrift("~~~md\n- A\n- B\n~~~\n", "~~~md\n- B\n- A\n~~~\n", () => "previous"), "tracker_changed");
  assert.equal(classifyCheckDrift("- A\n- B\n", "- B\n- A\n", () => "- A\n- B\n"), "reorder_only");
  assert.equal(classifyCheckDrift("- A\n- B", "- B\n- A", () => "- A\n- B"), "reorder_only");
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
    assert.equal(reorder.classification, "tracker_changed");
    assert.equal(reorder.regeneration_command, undefined);
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

test("regeneration model ignores host argv, retains canonical values and quoting, and keeps pm-arg pairs", async (t) => {
  const f = await fixture(t);
  const argv = process.argv;
  const target = "release notes' \"quoted\".md";
  try {
    process.argv = [process.execPath, "unrelated-host.js", "pm", "--check", "--wrong"];
    const parsed = cliTestSurface.parseArgs([...f.args, "--output", target, "--title", "Notes' \"quoted\" $literal", "--check", "--pm-arg=--output-budget", "--pm-arg=unbounded"]);
    const model = cliTestSurface.cliRegenerationOptions(parsed);
    const guidance = regenerationCommand(model, ["node", CLI], "linux");
    assert.deepEqual(guidance.argv.slice(0, 2), ["node", CLI]);
    assert.ok(!guidance.argv.some((arg) => arg === "--check" || arg === "--wrong" || arg === "unrelated-host.js"));
    assert.ok(guidance.argv.includes("--pm-arg=--output-budget"));
    assert.ok(guidance.argv.includes("--pm-arg=unbounded"));
    assert.ok(guidance.argv.includes(`--output=${target}`));
    assert.equal(guidance.input_required, false);
    assert.match(guidance.command!, /'\\''/);
    const result = spawnSync(guidance.command!, { cwd: f.cwd, shell: true, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(f.cwd, target), "utf8"), /Notes/);
    const regenerated = cliTestSurface.parseArgs(guidance.argv.slice(2));
    assert.deepEqual(cliTestSurface.cliRegenerationOptions(regenerated), model);
  } finally { process.argv = argv; }
});

test("win32 regeneration gives PowerShell-safe quotes and lossless argv", () => {
  const guidance = regenerationCommand({ output: "release notes' \"quoted\".md", title: "$literal` and 'quotes'", check: true }, ["node", "C:\\Program Files\\pm\\cli.js"], "win32");
  assert.equal(guidance.shell, "powershell");
  assert.equal(guidance.command, "& 'node' 'C:\\Program Files\\pm\\cli.js' '--output=release notes'' \"quoted\".md' '--title=$literal` and ''quotes'''" );
  assert.deepEqual(guidance.argv, ["node", "C:\\Program Files\\pm\\cli.js", "--output=release notes' \"quoted\".md", "--title=$literal` and 'quotes'"]);
  assert.ok(guidance.message.includes(JSON.stringify(guidance.argv)));
});

test("stdin regeneration requires the original pipe rather than a silently different command", async (t) => {
  const f = await fixture(t);
  const generated = readFileSync(f.output, "utf8");
  writeFileSync(f.output, generated.replace("# Changelog\n", "# Changelog\n\n## Unreleased\n\nNo changes.\n"));
  const input = JSON.stringify({ items: (await listAllComplete({}, { pmRoot: f.pmRoot })).items });
  const args = ["--stdin", "--pm-root", f.pmRoot, "--output", f.output, "--version", "1.2.0", "--date", "2026-11-01", "--mode", "prepend", "--check"];
  for (const extra of [[], ["--json"]]) {
    const result = spawnSync(process.execPath, [CLI, ...args, ...extra], { cwd: f.cwd, input, encoding: "utf8" });
    assert.equal(result.status, 1);
    if (extra.length) {
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.regeneration_input_required, true);
      assert.equal(receipt.regeneration_command, undefined);
      assert.ok(receipt.regeneration_argv.includes("--stdin"));
      assert.match(receipt.message, /requires the same stdin input or original pipe/);
    } else assert.match(result.stderr, /requires the same stdin input or original pipe/);
  }
});

test("same-version reorder never becomes an upgrade even when a supplied renderer reproduces it", async (t) => {
  const f = await fixture(t);
  const current = readFileSync(f.output, "utf8");
  const entries = current.split("\n").filter((line) => line.startsWith("- "));
  const reordered = current.replace(entries.join("\n"), [...entries].reverse().join("\n"));
  assert.equal(classify(reordered, current, () => reordered, { current: RENDERING_VERSION, previous: RENDERING_VERSION }), "tracker_changed");
  assert.equal(classify(reordered, current, () => reordered, { current: RENDERING_VERSION, previous: PREVIOUS_RENDERING_VERSION }), "reorder_only");
  assert.equal(classify(reordered, current, () => current, { current: RENDERING_VERSION, previous: PREVIOUS_RENDERING_VERSION }), "tracker_changed");
  await runUpdate("check-beta", { completedAt: "2026-11-02T00:00:00Z" }, { path: f.pmRoot });
  const checked = f.run(["--check", "--json"]);
  assert.equal(checked.status, 1);
  const receipt = JSON.parse(checked.stdout);
  assert.equal(receipt.classification, "tracker_changed");
  assert.match(receipt.message, /completed_at edit or manual reorder/);
  assert.doesNotMatch(receipt.message, /one-time regeneration/);
});

test("blank-separated multiline details remain attached to their entry during reorder classification", async (t) => {
  const f = await fixture(t);
  const markdown = readFileSync(f.output, "utf8");
  const header = markdown.slice(0, markdown.indexOf("\n- ") + 1);
  const before = header + "- Alpha\n\n  Details for Alpha\n- Beta\n\n\n  Details for Beta\n";
  const wrong = header + "- Beta\n\n  Details for Alpha\n- Alpha\n\n\n  Details for Beta\n";
  const correct = header + "- Beta\n\n\n  Details for Beta\n- Alpha\n\n  Details for Alpha\n";
  assert.equal(isEntryReorder(before, wrong), false);
  assert.equal(classifyCheckDrift(before, wrong, () => "previous"), "tracker_changed");
  assert.equal(classifyCheckDrift(before, correct, () => before), "reorder_only");
});

test("every rendering-change item has a published consumer upgrade catalog action", async () => {
  const items = (await listAllComplete({}, { pmRoot: resolve(".agents/pm") })).items.filter((item) => item.tags?.includes("rendering-change"));
  assert.ok(items.length >= 3);
  for (const expected of ["pmc-total-item-order", "pmc-contract-changes", "pmc-stable-itemless-check"]) assert.ok(items.some((item) => item.id === expected));
  for (const item of items) {
    assert.equal(typeof item.release, "string");
    const report = await readConsumerUpgrades(resolve(".agents/pm"), { audience: "operator", from: "0.0.0", to: String(item.release) });
    assert.ok(report.steps.some((step) => step.attribution.some((ref) => ref.item === item.id)), `${item.id} needs an upgrade action`);
  }
});


test("registered generate checks share diagnoses, remedies and nonzero typed receipts on a real tracker", async (t) => {
  const f = await fixture(t);
  const installed = join(f.pmRoot, "extensions/pm-changelog");
  mkdirSync(installed, { recursive: true });
  cpSync(resolve("dist"), join(installed, "dist"), { recursive: true });
  cpSync(resolve("manifest.json"), join(installed, "manifest.json"));
  writeFileSync(join(installed, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(resolve("node_modules"), join(installed, "node_modules"), "junction");
  const originalArgv = process.argv;
  process.argv = [process.execPath, "custom-extension-host.js", "pm", "changelog", "generate"];
  t.after(() => { process.argv = originalArgv; });
  const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] });
  assert.deepEqual(activation.failed, []);
  const options = { output: f.output, releaseVersion: "1.2.0", date: "2026-11-01", contributors: false, "emoji-prefix": undefined };
  const run = (extra = {}) => runRegisteredCommandForTest(activation.commands, { command: "changelog generate", options: { ...options, ...extra }, pmRoot: f.pmRoot });
  await run();
  const current = readFileSync(f.output, "utf8");
  const entries = current.split("\n").filter((line) => line.startsWith("- "));
  writeFileSync(f.output, current.replace(entries.join("\n"), [...entries].reverse().join("\n")));
  await assert.rejects(() => run({ check: true }), (error: unknown) => {
    assert.ok(error instanceof PmCliError);
    assert.equal(error.exitCode, 1);
    assert.equal(error.code, "tracker_changed");
    assert.match(error.message, /completed_at edit or manual reorder/);
    assert.equal(error.context.required, undefined);
    return true;
  });
  writeFileSync(f.output, current.replace("# Changelog\n", "# Changelog\n\n## Unreleased\n\nNo changes.\n"));
  await assert.rejects(() => run({ check: true, mode: "prepend" }), (error: unknown) => {
    assert.ok(error instanceof PmCliError);
    assert.equal(error.code, "rendering_changed");
    assert.match(error.message, /this is a one-time regeneration after a pm-changelog upgrade/);
    assert.match(error.context.required!, /^pm --path /);
    assert.ok(error.context.required!.includes(f.pmRoot));
    assert.ok(error.context.required!.includes("changelog generate"));
    assert.ok(error.context.required!.includes("--release-version=1.2.0"));
    assert.ok(!error.context.required!.includes("--releaseVersion"));
    assert.ok(!error.context.required!.includes("custom-extension-host.js"));
    const argv = JSON.parse(error.context.verification_errors!.find((line) => line.startsWith("regeneration_argv="))!.slice("regeneration_argv=".length));
    assert.deepEqual(argv.slice(0, 3), ["pm", "--path", f.pmRoot]);
    assert.deepEqual(argv.slice(argv.indexOf("changelog"), argv.indexOf("changelog") + 2), ["changelog", "generate"]);
    assert.equal(argv.filter((arg: string) => arg === "pm").length, 1);
    const copied = spawnSync(error.context.required!, { cwd: f.cwd, shell: true, encoding: "utf8",
      env: { ...process.env, PATH: dirname(PM) + delimiter + process.env.PATH, DO_NOT_TRACK: "1", PM_AUTHOR: "codex-changelog339-1111", PM_TELEMETRY_SOURCE_CONTEXT: "automation" } });
    assert.equal(copied.status, 0, copied.stdout + copied.stderr);
    assert.equal(readFileSync(f.output, "utf8"), current);
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


test("canonical host option registry accepts aliases, preserves canonical precedence and repeated values", () => {
  const result = canonicalRegenerationOptions({ releaseVersion: "1.0.0", "release-version": "2.0.0", excludeTag: ["a", "b"], explainSelection: true, noDependencyUpdates: true, absent: undefined, constructor: "ignored", output: {}, count: 2 },
    [{ long: "--release-version" }, { long: "--exclude-tag" }, { long: "--explain-selection" }, { long: "--no-dependency-updates" }, { long: "--output" }, { long: "--count" }, {}]);
  assert.deepEqual({ ...result }, { "release-version": "2.0.0", "exclude-tag": ["a", "b"], "explain-selection": true, "no-dependency-updates": true, count: 2 });
  assert.deepEqual({ ...canonicalRegenerationOptions({ "release-version": "2.0.0", releaseVersion: "1.0.0", output: [false] }, [{ long: "--release-version" }, { long: "--output" }]) }, { "release-version": "2.0.0" });
});
