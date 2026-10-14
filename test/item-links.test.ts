import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { lexer, walkTokens } from "marked";
import { getActiveExtensionRegistrations, readSettings, resolveItemTypeRegistry, runCreate, runWithActiveExtensions } from "@unbrained/pm-cli/sdk";
import { cliTestSurface } from "../src/cli.ts";
import { checkItemLinks, createChangelog, readPmItems } from "../src/index.ts";
import { markdownLinkTargets } from "../src/item-links.ts";

const base = "https://example.test/blob/main/.agents/pm";

/** Initialize a real tracker with project and extension folders that pluralization cannot infer. */
async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "pm-changelog-item-links-"));
  const pmRoot = join(cwd, ".agents", "pm");
  const cli = join(process.cwd(), "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  const env = { ...process.env, PM_PATH: pmRoot, PM_GLOBAL_PATH: join(cwd, "global"), DO_NOT_TRACK: "1" };
  try {
    for (const args of [
      ["init", "--yes", "--agent-guidance", "skip"],
      ["schema", "add-type", "ReviewFinding", "--folder", "review-findings"],
      ["schema", "add-type", "SpacedFinding", "--folder", "review notes"],
    ]) execFileSync(process.execPath, [cli, ...args], { cwd, env, stdio: "pipe" });
    const extensionRoot = join(pmRoot, "extensions", "link-types");
    mkdirSync(extensionRoot, { recursive: true });
    writeFileSync(join(extensionRoot, "manifest.json"), JSON.stringify({ name: "link-types", version: "1.0.0", entry: "./index.mjs", capabilities: ["schema"] }));
    writeFileSync(join(extensionRoot, "index.mjs"), "export function activate(api) { api.registerItemTypes([{ name: 'ExtensionFinding', folder: 'extension-findings' }]); }");
    const folders = await runWithActiveExtensions({ path: pmRoot }, async () => {
      for (const type of ["ReviewFinding", "SpacedFinding", "ExtensionFinding", "Issue", "Task", "Feature", "Chore", "Decision", "Epic", "Event", "Meeting", "Milestone", "Plan", "Reminder"]) {
        await runCreate({ title: `Completed ${type}`, type, status: "closed", createMode: "progressive", closeReason: "Fixture accepted", completedAt: "2026-10-01T00:00:00.000Z" }, { path: pmRoot });
      }
      return resolveItemTypeRegistry(await readSettings(pmRoot), getActiveExtensionRegistrations()).type_to_folder;
    });
    return { cwd, pmRoot, env, folders };
  } catch (error) {
    rmSync(cwd, { recursive: true, force: true });
    throw error;
  }
}

/** Invoke the built package CLI against this tracker and capture both streams. */
function generate(f: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  return spawnSync(process.execPath, [join(process.cwd(), "dist", "cli.js"), "--pm-root", f.pmRoot, "--item-url-base", base, ...args], { cwd: f.cwd, env: f.env, encoding: "utf8" });
}

test("real project and extension type links use registry folders and every emitted path exists", async () => {
  const f = await fixture();
  try {
    const items = readPmItems({ cwd: f.cwd, pmRoot: f.pmRoot, env: f.env, pmArgs: ["--output-budget=1", "--output-limit=1"] });
    assert.equal(items.length, 14);
    const wrapper = join(f.cwd, "pm-wrapper.mjs");
    writeFileSync(wrapper, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("schema")) {
  if (process.env.PM_CHANGELOG_SCHEMA_FAILURE === "message") process.stderr.write("Schema transport unavailable");
  process.exit(2);
}
const result = spawnSync(process.execPath, [process.env.PM_CHANGELOG_TEST_CLI, ...args], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`);
    chmodSync(wrapper, 0o755);
    for (const failure of ["message", "silent"]) {
      assert.throws(() => readPmItems({ cwd: f.cwd, pmRoot: f.pmRoot,
        env: { ...f.env, PM_CHANGELOG_SCHEMA_FAILURE: failure, PM_CHANGELOG_TEST_CLI: join(process.cwd(), "node_modules", "@unbrained", "pm-cli", "dist", "cli.js") },
        pmBin: wrapper,
      }), failure === "message" ? /Schema transport unavailable/ : /pm schema list --json failed/);
    }
    const input = join(f.cwd, "items.json");
    writeFileSync(input, JSON.stringify(items));
    const options = { items, itemUrlBase: base };
    const generated = createChangelog(options);
    const links = [...generated.markdown.matchAll(/\]\(([^)]+)\)/g)];
    assert.equal(links.length, items.length);
    for (const match of links) assert.ok(existsSync(join(f.pmRoot, decodeURIComponent(match[1].slice(base.length + 1)))), match[1]);
    assert.match(generated.markdown, /\/review-findings\/[^)]+\.toon/);
    assert.match(generated.markdown, /\/review%20notes\//);
    assert.match(generated.markdown, /\/extension-findings\/[^)]+\.toon/);
    checkItemLinks(generated.markdown, f.pmRoot, `${base}/`);
    const plainItems = items.map(({ itemFolder: _folder, ...item }) => item);
    assert.equal(createChangelog({ ...options, items: plainItems, itemTypeFolders: f.folders }).markdown, generated.markdown);
    assert.throws(() => createChangelog({ ...options, items: plainItems }), /No registered tracker folder/);
    const command = generate(f, ["--stdout", "--check-links"]);
    assert.equal(command.status, 0, command.stderr);
    assert.match(command.stdout, /\/review-findings\//);
    const output = join(f.cwd, "CHANGELOG.md");
    assert.equal(generate(f, ["--output", output, "--check-links"]).status, 0);
    assert.equal(generate(f, ["--output", output, "--check", "--check-links"]).status, 0);
    const inProcess = ["--input", input, "--pm-root", f.pmRoot, "--pm-cwd", f.cwd, "--output", output, "--item-url-base", base, "--check-links"];
    await cliTestSurface.main(inProcess);
    await cliTestSurface.main(inProcess.filter((arg) => arg !== "--pm-cwd" && arg !== f.cwd));
    await cliTestSurface.main([...inProcess, "--mode", "prepend"]);
    writeFileSync(output, readFileSync(output, "utf8") + `\n## 0.0.0 - 2025-01-01\n\n[missing](${base}/reviewfindings/absent.toon "tracker item")\n`);
    const prepend = generate(f, ["--output", output, "--mode", "prepend", "--check-links"]);
    assert.equal(prepend.status, 1);
    assert.match(prepend.stderr, /no tracker file/);
    await assert.rejects(cliTestSurface.main([...inProcess, "--mode", "prepend"]), /no tracker file/);
    assert.equal(generate(f, ["--output", output, "--mode", "prepend", "--stdout", "--check-links"]).status, 1);
    assert.match(readFileSync(output, "utf8"), /reviewfindings/);
    const noBase = spawnSync(process.execPath, [join(process.cwd(), "dist", "cli.js"), "--pm-root", f.pmRoot, "--stdout", "--check-links"], { cwd: f.cwd, env: f.env, encoding: "utf8" });
    assert.equal(noBase.status, 1);
    assert.match(noBase.stderr, /requires --item-url-base/);
    await assert.rejects(cliTestSurface.main(["--input", input, "--check-links"]), /requires --item-url-base/);
  } finally {
    rmSync(f.cwd, { recursive: true, force: true });
  }
});

test("link validity rejects missing files, directories, traversal and symlinks outside the tracker", () => {
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-link-check-"));
  const pmRoot = join(directory, "tracker");
  mkdirSync(pmRoot);
  writeFileSync(join(directory, "outside.toon"), "fixture");
  symlinkSync(join(directory, "outside.toon"), join(pmRoot, "symlink.toon"));
  try {
    assert.throws(() => createChangelog({ items: [{ id: "fixture", title: "Unknown type", status: "closed", type: "constructor" }], itemTypeFolders: {}, itemUrlBase: base }), /No registered tracker folder/);
    checkItemLinks("[external](https://example.test/other)", pmRoot, base);
    assert.throws(() => checkItemLinks(`[missing](${base}/absent.toon)`, pmRoot, base), /no tracker file/);
    assert.throws(() => checkItemLinks(`[directory](${base}/.)`, pmRoot, base), /no tracker file/);
    for (const path of ["../outside.toon", "%2e%2e/outside.toon", "symlink.toon"]) {
      assert.throws(() => checkItemLinks(`[escape](${base}/${path})`, pmRoot, base), /escapes the pm root/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema lookup preserves existing folders for archived and still-registered custom items", async () => {
  const f = await fixture();
  try {
    const wrapper = join(f.cwd, "archived-items.ts");
    writeFileSync(wrapper, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, [process.env.PM_CHANGELOG_TEST_CLI, ...process.argv.slice(2)], { encoding: "utf8", env: process.env });
if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 1); }
if (process.argv.includes("list") && !process.argv.includes("schema")) {
  const output = JSON.parse(result.stdout);
  output.items.push(
    { id: "archived", title: "Archived custom item", type: "RemovedType", itemFolder: "archives", status: "closed" },
    { id: "registered", title: "Supplied custom folder", type: "ReviewFinding", itemFolder: "archives", status: "closed" }
  );
  output.count = output.total = output.items.length;
  process.stdout.write(JSON.stringify(output));
} else process.stdout.write(result.stdout);
`);
    chmodSync(wrapper, 0o755);
    mkdirSync(join(f.pmRoot, "archives"));
    for (const id of ["archived", "registered"]) writeFileSync(join(f.pmRoot, "archives", `${id}.toon`), "fixture");
    const items = readPmItems({ cwd: f.cwd, pmRoot: f.pmRoot, pmBin: wrapper,
      env: { ...f.env, PM_CHANGELOG_TEST_CLI: join(process.cwd(), "node_modules", "@unbrained", "pm-cli", "dist", "cli.js") } });
    assert.equal(items.find((item) => item.id === "archived")?.itemFolder, "archives");
    assert.equal(items.find((item) => item.id === "registered")?.itemFolder, "archives");
    assert.equal(items.find((item) => item.type === "ReviewFinding" && item.id !== "registered")?.itemFolder, "review-findings");
    const generated = createChangelog({ items, itemUrlBase: base });
    assert.match(generated.markdown, /\/archives\/archived\.toon/);
    assert.match(generated.markdown, /\/archives\/registered\.toon/);
    checkItemLinks(generated.markdown, f.pmRoot, base);
  } finally {
    rmSync(f.cwd, { recursive: true, force: true });
  }
});

test("generated links encode parentheses in every folder segment and item id", async () => {
  const f = await fixture();
  try {
    const itemFolder = "reviews(qa)/closed)";
    const id = "item(qa)";
    mkdirSync(join(f.pmRoot, itemFolder), { recursive: true });
    writeFileSync(join(f.pmRoot, itemFolder, `${id}.toon`), "fixture");
    const items = [{ id, title: "Parenthesized path", type: "ReviewFinding", itemFolder, status: "closed" }];
    const generated = createChangelog({ items, itemUrlBase: base });
    const expected = `${base}/reviews%28qa%29/closed%29/item%28qa%29.toon`;
    assert.deepEqual([...markdownLinkTargets(generated.markdown)], [expected]);
    const renderedLinks: string[] = [];
    walkTokens(lexer(generated.markdown), (token) => { if (token.type === "link") renderedLinks.push(token.href); });
    assert.deepEqual(renderedLinks, [expected]);
    checkItemLinks(generated.markdown, f.pmRoot, base);
    const input = join(f.cwd, "parenthesized-items.json");
    writeFileSync(input, JSON.stringify(items));
    const command = generate(f, ["--input", input, "--stdout", "--check-links"]);
    assert.equal(command.status, 0, command.stderr);
    assert.ok(command.stdout.includes(expected));
  } finally {
    rmSync(f.cwd, { recursive: true, force: true });
  }
});

test("link checks validate destinations with double-quoted, single-quoted and parenthesized titles", () => {
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-titled-links-"));
  try {
    writeFileSync(join(directory, "present.toon"), "fixture");
    for (const title of ['"tracker item"', "'tracker item'", "(tracker item)"]) {
      const markdown = `[item](${base}/present.toon ${title})`;
      assert.deepEqual([...markdownLinkTargets(markdown)], [`${base}/present.toon`]);
      checkItemLinks(markdown, directory, base);
      assert.throws(() => checkItemLinks(`[item](${base}/missing.toon ${title})`, directory, base), /no tracker file/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("link checks strip literal query and fragment suffixes before decoding and preserve containment", () => {
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-url-suffixes-"));
  const pmRoot = join(directory, "tracker");
  mkdirSync(pmRoot);
  for (const file of ["present.toon", "encoded?#.toon"]) writeFileSync(join(pmRoot, file), "fixture");
  writeFileSync(join(directory, "outside.toon"), "fixture");
  symlinkSync(join(directory, "outside.toon"), join(pmRoot, "symlink.toon"));
  try {
    for (const suffix of ["#L2", "?raw=1", "?raw=1#L2", "#L2?raw=1", "?q=%ZZ#fragment"]) {
      checkItemLinks(`[item](${base}/present.toon${suffix})`, pmRoot, base);
      checkItemLinks(`[encoded](${base}/encoded%3F%23.toon${suffix})`, pmRoot, base);
      assert.throws(() => checkItemLinks(`[missing](${base}/missing.toon${suffix})`, pmRoot, base), /no tracker file/);
      for (const path of ["../outside.toon", "%2e%2e/outside.toon", "symlink.toon"]) {
        assert.throws(() => checkItemLinks(`[escape](${base}/${path}${suffix})`, pmRoot, base), /escapes the pm root/);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("link targets match the former regex exactly and stay linear on hostile markdown", () => {
  // The regex CodeQL flagged as polynomial (js/polynomial-redos), kept here only as the oracle.
  const oracle = (markdown: string): string[] => [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!);
  const samples = [
    "- [a](https://x/a.toon) and [b](https://x/b.toon)",
    "](no-close", "]()", "]( spaced)", "](a](b)", "](a b)(c)", "]]((x)", "](\u00a0x)", "](x\ny)", "[t](u)](v)", "",
  ];
  for (const sample of samples) assert.deepEqual([...markdownLinkTargets(sample)], oracle(sample), JSON.stringify(sample));
  const titledSamples = [
    '[a](https://x/a.toon "title")', "[a](https://x/a.toon 'title')", "[a](https://x/a.toon (title))",
    '[a](u "") [b](v \'\') [c](w ())',
    '[a](u "escaped \\\"quote\\\" and ](text")',
    "[a](u 'escaped \\'quote\\'')", "[a](u (escaped \\(paren\\)))",
    '[a](u\t"title" \t) [b](v\n\'title\'\n)',
    '[a](u )',
    '[bad](u "unterminated [good](v)', '[bad](u "closed" junk) [good](v)',
    '[bad](u invalid) [good](v)',
    '[bad](u "trailing\\', '[bad](u (unterminated',
  ];
  for (const sample of titledSamples) {
    const expected: string[] = [];
    walkTokens(lexer(sample), (token) => { if (token.type === "link") expected.push(token.href); });
    assert.deepEqual([...markdownLinkTargets(sample)], expected, JSON.stringify(sample));
  }
  // Preserve the old scanner's empty-destination behavior and reject unescaped
  // parentheses in titles as CommonMark requires (marked accepts nested ones).
  assert.deepEqual([...markdownLinkTargets('[empty]( "title")')], []);
  assert.deepEqual([...markdownLinkTargets('[bad](u (nested (title))) [good](v)')], ["v"]);
  const hostileInputs = [
    `](${"](!".repeat(200_000)}`,
    ...['"', "'", "("].map((delimiter) => `](u ${delimiter}`.repeat(20_000)),
  ];
  // The polynomial regex needs minutes here; the scanner needs milliseconds. A 1 s bound
  // still catches the regression while tolerating a loaded runner or coverage instrumentation.
  for (const hostile of hostileInputs) {
    const started = performance.now();
    assert.deepEqual([...markdownLinkTargets(hostile)], []);
    assert.ok(performance.now() - started < 1_000, "hostile destinations and titles must scan in linear time");
  }
});

test("link checks name a link whose path has a malformed percent escape", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-changelog-bad-escape-"));
  try {
    const pmRoot = join(root, ".agents", "pm");
    mkdirSync(join(pmRoot, "issues"), { recursive: true });
    assert.throws(
      () => checkItemLinks(`- [x](${base}/issues/%ZZ.toon)`, pmRoot, base),
      /Changelog item link has an invalid encoding: issues\/%ZZ\.toon/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
