/** Exercises the public CLI in-process so V8 attributes behavior to cli.ts. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { cliTestSurface, runCliEntry } from "../src/cli.ts";

/** Stable closed-item input shared by in-process CLI cases. */
const INPUT_DOCUMENT = JSON.stringify({
  items: [{
    id: "pmc-covered",
    title: "Add covered behavior",
    status: "closed",
    type: "Feature",
    tags: ["feature"],
    updated_at: "2026-08-07T00:00:00Z",
  }],
});

/** Creates an isolated fixture and registers deterministic cleanup. */
function fixture(t: TestContext): { directory: string; input: string } {
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-cli-coverage-"));
  const input = join(directory, "items.json");
  writeFileSync(input, INPUT_DOCUMENT, "utf-8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, input };
}

test("parser maps every supported option family without subprocess coverage", () => {
  const options = cliTestSurface.parseArgs([
    "-o", "out.md", "--stdout", "--json", "--check", "--no-check-diff", "--explain",
    "--github-output", "--github-step-summary", "-i", "items.json", "--stdin",
    "--pm-root", ".agents/pm", "--pm-bin", "pm", "--pm-arg", "--json", "--pm-cwd", ".",
    "--title", "Notes", "--release-version", "1.2.3", "--release-version-from-package",
    "--date", "2026-08-07", "--since", "2026-08-01", "--since-previous-tag",
    "--until", "2026-08-07", "--until-release-tag", "--all-release-tags",
    "--release-tag-pattern", "release-*", "--statuses", "closed, done", "--group-by", "release",
    "--section-by", "label", "--summary", "--format", "markdown", "--conventional",
    "--contributors", "--breaking-changes", "--suggest-semver", "--body-preview", "12",
    "--emoji-prefix", "--include-metadata", "--changelog-json", "--limit", "2",
    "--since-version", "1.0.0", "--mode", "prepend", "--include-empty", "--include-links",
    "--no-links", "--item-url-base", "https://example.test/items", "--item-ref-style", "GITHUB",
    "--respect-item-release", "--exclude-tags", "skip, private",
  ]);
  assert.equal(options.output, "out.md");
  assert.deepEqual(options.pmArgs, ["--json"]);
  assert.deepEqual(options.statuses, ["closed", "done"]);
  assert.deepEqual(options.excludeTags, ["skip", "private"]);
  assert.equal(options.groupBy, "release");
  assert.equal(options.sectionBy, "label");
  assert.equal(options.itemRefStyle, "github");
  assert.equal(options.includeLinks, false);
  assert.equal(options.format, "md");
  assert.equal(options.mode, "prepend");
});

test("argument helpers cover normalization, aliases, validation, and suggestions", () => {
  assert.deepEqual(cliTestSurface.normalizeArgs(["plain", "--stdout=true", "--title=Hello"]), [
    "plain", "--stdout=true", "--title", "Hello",
  ]);
  assert.equal(cliTestSurface.resolveOptionAlias("--release-version"), "--version");
  assert.equal(cliTestSurface.resolveOptionAlias("--title"), "--title");
  assert.equal(cliTestSurface.optionToken("--title=value"), "--title");
  assert.equal(cliTestSurface.optionToken("plain"), "plain");
  assert.equal(cliTestSurface.editDistance("same", "same"), 0);
  assert.equal(cliTestSurface.editDistance("cat", "cut"), 1);
  assert.equal(cliTestSurface.suggestOption("--versoin"), "--version");
  assert.equal(cliTestSurface.suggestOption("ac", ["ab", "a"]), "a");
  assert.equal(cliTestSurface.suggestOption("not-close-at-all"), undefined);
  assert.match(cliTestSurface.unknownOptionError("--versoin=1").message, /Did you mean '--version'/);
  assert.match(cliTestSurface.unknownOptionError("plain").message, /Unknown option: plain/);
  assert.equal(cliTestSurface.parseGroupBy("milestone"), "milestone");
  assert.equal(cliTestSurface.parseSectionBy("status"), "status");
  assert.equal(cliTestSurface.parseItemRefStyle(" Toon "), "toon");
  assert.equal(cliTestSurface.parseLimit("2"), 2);
  assert.equal(cliTestSurface.parseBodyPreview("3"), 3);
  assert.equal(cliTestSurface.parseMode("replace"), "replace");
  assert.equal(cliTestSurface.parseFormat("JSON"), "json");
  assert.throws(() => cliTestSurface.parseGroupBy("bad"), /--group-by/);
  assert.throws(() => cliTestSurface.parseSectionBy("bad"), /--section-by/);
  assert.throws(() => cliTestSurface.parseItemRefStyle("bad"), /--item-ref-style/);
  assert.throws(() => cliTestSurface.parseLimit("0"), /positive integer/);
  assert.throws(() => cliTestSurface.parseBodyPreview("0"), /positive integer/);
  assert.throws(() => cliTestSurface.parseMode("bad"), /--mode/);
  assert.throws(() => cliTestSurface.parseFormat("bad"), /--format/);
  assert.throws(() => cliTestSurface.requireValue([], 0, "--title"), /requires a value/);
  assert.throws(() => cliTestSurface.requireValue(["--json"], 0, "--title"), /requires a value/);
  assert.equal(cliTestSurface.requireValue(["value"], 0, "--title"), "value");
  assert.throws(() => cliTestSurface.requireAnyValue([], 0, "--pm-arg"), /requires a value/);
  assert.equal(cliTestSurface.requireAnyValue(["--json"], 0, "--pm-arg"), "--json");
  assert.throws(() => cliTestSurface.parseArgs(["--unknown"]), /Unknown option/);
});

test("in-process main renders summary, document, semver, and markdown modes", async (t) => {
  const { directory, input } = fixture(t);
  const writes: string[] = [];
  const errors: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  t.mock.method(console, "error", (...values: unknown[]) => {
    errors.push(values.map(String).join(" "));
  });
  await cliTestSurface.main(["--input", input, "--summary", "--format", "json", "--explain"]);
  assert.match(writes.join(""), /"selection_report"/);
  writes.length = 0;
  await cliTestSurface.main(["--input", input, "--summary", "--explain"]);
  assert.match(writes.join(""), /\[Unreleased\].*Add covered behavior.*pmc-covered/);
  assert.match(errors.join("\n"), /Selection report: input=1 visible=1/);
  writes.length = 0;
  errors.length = 0;
  await cliTestSurface.main(["--input", input, "--changelog-json"]);
  assert.match(writes.join(""), /"releases"/);
  writes.length = 0;
  await cliTestSurface.main(["--input", input, "--suggest-semver", "--explain"]);
  assert.match(writes.join(""), /"bump"/);
  assert.match(writes.join(""), /"selection_report"/);
  writes.length = 0;
  await cliTestSurface.main(["--input", input, "--stdout", "--mode", "prepend", "--output", join(directory, "missing.md")]);
  assert.match(writes.join(""), /# Changelog/);
});

test("in-process main writes files, workflow outputs, check diffs, and JSON stdout", async (t) => {
  const { directory, input } = fixture(t);
  const output = join(directory, "CHANGELOG.md");
  const githubOutput = join(directory, "github-output.txt");
  const githubSummary = join(directory, "github-summary.md");
  const stdoutWrites: string[] = [];
  const consoleErrors: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
  t.mock.method(process.stderr, "write", () => true);
  t.mock.method(console, "error", (...values: unknown[]) => {
    consoleErrors.push(values.map(String).join(" "));
  });
  const previousOutput = process.env.GITHUB_OUTPUT;
  const previousSummary = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_OUTPUT = githubOutput;
  process.env.GITHUB_STEP_SUMMARY = githubSummary;
  try {
    await cliTestSurface.main([
      "--input", input, "--output", output, "--json", "--github-output", "--github-step-summary",
    ]);
    assert.match(readFileSync(output, "utf-8"), /Add covered behavior/);
    assert.match(readFileSync(githubOutput, "utf-8"), /item_count=1/);
    assert.match(readFileSync(githubSummary, "utf-8"), /# Changelog/);
    await cliTestSurface.main(["--input", input, "--output", output, "--explain"]);
    assert.match(consoleErrors.join("\n"), /Selection report: input=1 visible=1/);
    writeFileSync(output, "stale\n", "utf-8");
    process.exitCode = undefined;
    await cliTestSurface.main(["--input", input, "--output", output, "--check"]);
    assert.equal(process.exitCode, 1);
    process.exitCode = undefined;
    stdoutWrites.length = 0;
    const githubOutputBefore = readFileSync(githubOutput, "utf-8");
    const githubSummaryBefore = readFileSync(githubSummary, "utf-8");
    await cliTestSurface.main([
      "--input", input, "--stdout", "--json", "--mode", "replace", "--github-output",
      "--github-step-summary",
    ]);
    assert.match(stdoutWrites.join(""), /"itemCount":1/);
    assert.match(readFileSync(githubOutput, "utf-8").slice(githubOutputBefore.length), /item_count=1/);
    assert.match(readFileSync(githubSummary, "utf-8").slice(githubSummaryBefore.length), /# Changelog/);
    stdoutWrites.length = 0;
    const markdownSummaryBefore = readFileSync(githubSummary, "utf-8");
    await cliTestSurface.main(["--input", input, "--stdout", "--github-step-summary"]);
    assert.match(stdoutWrites.join(""), /# Changelog/);
    assert.match(readFileSync(githubSummary, "utf-8").slice(markdownSummaryBefore.length), /# Changelog/);
  } finally {
    if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previousOutput;
    if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previousSummary;
    process.exitCode = undefined;
  }
});

test("workflow writers reject absent environment targets and helper projections stay stable", () => {
  const githubOutput = process.env.GITHUB_OUTPUT;
  const githubSummary = process.env.GITHUB_STEP_SUMMARY;
  delete process.env.GITHUB_OUTPUT;
  delete process.env.GITHUB_STEP_SUMMARY;
  try {
    assert.throws(() => cliTestSurface.writeGitHubOutput({}), /GITHUB_OUTPUT/);
    assert.throws(() => cliTestSurface.writeGitHubStepSummary("x"), /GITHUB_STEP_SUMMARY/);
  } finally {
    if (githubOutput !== undefined) process.env.GITHUB_OUTPUT = githubOutput;
    if (githubSummary !== undefined) process.env.GITHUB_STEP_SUMMARY = githubSummary;
  }
  const options = cliTestSurface.parseArgs([]);
  assert.equal(cliTestSurface.buildGenerationOptions(options, []).excludeTags, undefined);
  assert.deepEqual(cliTestSurface.buildSummary(options, {
    action: "created",
    changed: true,
    markdown: "# Notes\n",
    itemCount: 1,
    bytes: 8,
  }), {
    output: undefined,
    mode: "replace",
    action: "created",
    changed: true,
    itemCount: 1,
    bytes: 8,
    check: false,
    markdown: undefined,
  });
  assert.equal(cliTestSurface.errorMessage(new Error("failure")), "failure");
  assert.equal(cliTestSurface.errorMessage("string failure"), "string failure");
});

test("GitHub output preserves supplied values and stdout prepend reads an existing file", async (t) => {
  const { directory, input } = fixture(t);
  const githubOutput = join(directory, "github-output.txt");
  const output = join(directory, "CHANGELOG.md");
  writeFileSync(output, "# Changelog\n\n## 1.0.0\n\n- Existing\n", "utf-8");
  const previousOutput = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = githubOutput;
  t.after(() => {
    if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previousOutput;
  });
  cliTestSurface.writeGitHubOutput({
    output,
    mode: "prepend",
    action: "updated",
    changed: true,
    itemCount: 1,
    bytes: 10,
  });
  cliTestSurface.writeGitHubOutput({});
  assert.match(readFileSync(githubOutput, "utf-8"), /mode=prepend/);
  t.mock.method(process.stdout, "write", () => true);
  await cliTestSurface.main(["--input", input, "--stdout", "--mode", "prepend", "--output", output]);

  const options = cliTestSurface.parseArgs([]);
  options.bodyPreview = 0;
  const wrapper = join(directory, "pm-wrapper.mjs");
  writeFileSync(wrapper, `process.stdout.write(${JSON.stringify(INPUT_DOCUMENT)});\n`, "utf-8");
  options.pmBin = process.execPath;
  options.pmArgs = [wrapper];
  assert.ok(Array.isArray(await cliTestSurface.loadItems(options)));
});

test("stdin readers accept item documents and propagate stream failures", async () => {
  const input = new PassThrough();
  input.end(INPUT_DOCUMENT);
  assert.equal((await cliTestSurface.loadItems({ ...cliTestSurface.parseArgs(["--stdin"]) }, input))[0]?.id, "pmc-covered");

  const failure = new PassThrough();
  const reading = cliTestSurface.readStdin(failure);
  failure.destroy(new Error("stdin failed"));
  await assert.rejects(reading, /stdin failed/);
});

test("all-release context resolves real repository tags and package version", () => {
  const options = cliTestSurface.parseArgs([
    "--all-release-tags",
    "--release-version-from-package",
    "--pm-cwd",
    process.cwd(),
  ]);
  cliTestSurface.applyReleaseContext(options);
  // The committed version is mutable: the daily release workflow runs
  // `npm version` before `npm test`, so on release day the resolved value is
  // the not-yet-tagged next version. Asserting a frozen literal here made
  // every release fail at "Run release checks". Read the expected value from
  // the same package.json the resolution mechanism reads, so the assertion
  // holds at any committed or bumped version and still fails the moment
  // applyReleaseContext stops populating options.version.
  const expectedVersion = (JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf-8",
  )) as { version: string }).version;
  assert.equal(options.version, expectedVersion);
  assert.ok(options.releaseWindows && options.releaseWindows.length > 0);
});

test("entry guard rejects imports and accepts the real script path", async (t) => {
  assert.equal(await runCliEntry(["node"]), false);
  assert.equal(await runCliEntry(["node", import.meta.dirname]), false);
  assert.equal(await runCliEntry(["node", join(tmpdir(), "pm-changelog-missing-entry.ts")]), false);
  const { input } = fixture(t);
  const alias = join(dirname(input), "cli-entry.ts");
  try {
    symlinkSync(realpathSync(fileURLToPath(new URL("../src/cli.ts", import.meta.url))), alias, "file");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
      t.skip(`symlink creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const writes: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  assert.equal(await runCliEntry([
    "node",
    alias,
    "--input",
    input,
    "--summary",
  ]), true);
});
