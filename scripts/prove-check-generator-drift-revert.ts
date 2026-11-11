/** Prove issue 339 regressions reject behavioral reverts in an owned disposable package. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readProofBaseline } from "./proof-baseline.ts";
import { listAllComplete } from "@unbrained/pm-cli/sdk";

const scratch = mkdtempSync(join(tmpdir(), "pm-check-drift-revert-"));
try {
  for (const directory of ["src", "dist", "test"]) cpSync(resolve(directory), join(scratch, directory), { recursive: true });
  for (const file of ["package.json", "manifest.json"]) cpSync(resolve(file), join(scratch, file));
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");
  const pmRoot = join(scratch, ".agents/pm");
  mkdirSync(join(pmRoot, "issues"), { recursive: true });
  mkdirSync(join(pmRoot, "history"));
  cpSync(resolve(".agents/pm/settings.json"), join(pmRoot, "settings.json"));
  for (const id of ["pmc-total-item-order", "pmc-contract-changes", "pmc-stable-itemless-check"]) {
    for (const file of [`issues/${id}.toon`, `history/${id}.jsonl`]) cpSync(resolve(".agents/pm", file), join(pmRoot, file));
  }
  const extension = join(pmRoot, "extensions/pm-changelog");
  mkdirSync(extension, { recursive: true });
  cpSync(resolve("dist"), join(extension, "dist"), { recursive: true });
  cpSync(resolve("manifest.json"), join(extension, "manifest.json"));
  writeFileSync(join(extension, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(resolve("node_modules"), join(extension, "node_modules"), "junction");
  /** Run only the selected real-tracker assertions, preserving the production package. */
  const run = (pattern = ".*") => spawnSync(process.execPath, ["--test", "--test-concurrency=2", "--test-reporter=tap",
    `--test-name-pattern=${pattern}`, "test/check-generator-drift.test.ts"], {
    cwd: scratch, encoding: "utf8", timeout: 1200000,
    env: { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PM_AUTHOR: "codex-changelog339-1111", PM_TELEMETRY_SOURCE_CONTEXT: "automation", DO_NOT_TRACK: "1" },
  });
  /** Require a real assertion failure rather than a syntax, setup or timeout error. */
  const fails = (pattern: string, count: number): void => {
    const result = run(pattern);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`# fail ${count}\\b`));
    assert.match(result.stdout, /ERR_ASSERTION|AssertionError/);
  };
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  const passCount = Number(/# pass (\d+)/.exec(baseline.stdout)![1]);
  const cli = join(scratch, "src/cli.ts"), fixedCli = readFileSync(cli, "utf8");
  const original = readProofBaseline(process.cwd());
  console.log(JSON.stringify({ baseline: original.kind }));
  /** Select only main, so every other fixed function remains in place. */
  const main = (source: string): string => {
    const start = source.indexOf("async function main(");
    assert.ok(start >= 0);
    return source.slice(start, source.indexOf("\n}", start) + 2);
  };
  try {
    let previousMain = main(original.source);
    const start = previousMain.indexOf("    let driftMessage:");
    if (start !== -1) {
      const end = previousMain.indexOf("    if (options.githubOutput)", start);
      assert.ok(end > start);
      previousMain = previousMain.slice(0, start) + "    let driftMessage: string | undefined;\n\n" + previousMain.slice(end);
    }
    writeFileSync(cli, fixedCli.replace(main(fixedCli), previousMain));
    fails("^real non-git tracker:", 2);
    console.log(JSON.stringify({ mutation: "revert-main-diagnostics", reverted_fail: 2 }));
  } finally { writeFileSync(cli, fixedCli); }
  try {
    const from = "process.exitCode = 1;\n      return;";
    assert.ok(fixedCli.includes(from));
    writeFileSync(cli, fixedCli.replace(from, "process.exitCode = 0;\n      return;"));
    fails("^real non-git tracker:", 2);
    console.log(JSON.stringify({ mutation: "remove-failure-exit", reverted_fail: 2 }));
  } finally { writeFileSync(cli, fixedCli); }
  const generator = join(scratch, "src/generator.ts"), fixedGenerator = readFileSync(generator, "utf8");
  try {
    const from = "let next = renderingVersion === PREVIOUS_RENDERING_VERSION ? existing : omitEmptyUnreleasedSections(existing);";
    assert.ok(fixedGenerator.includes(from));
    writeFileSync(generator, fixedGenerator.replace(from, "let next = omitEmptyUnreleasedSections(existing);"));
    fails("^same real tracker:", 1);
    console.log(JSON.stringify({ mutation: "remove-previous-rendering-profile", reverted_fail: 1 }));
  } finally { writeFileSync(generator, fixedGenerator); }
  try {
    const from = "if (renderingVersion === PREVIOUS_RENDERING_VERSION) {";
    assert.ok(fixedGenerator.includes(from));
    writeFileSync(generator, fixedGenerator.replace(from, "if (false) {"));
    fails("^previous dependency selection", 1);
    console.log(JSON.stringify({ mutation: "remove-previous-dependency-selection", reverted_fail: 1 }));
  } finally { writeFileSync(generator, fixedGenerator); }
  const driftFile = join(scratch, "src/check-drift.ts"), fixedDrift = readFileSync(driftFile, "utf8");
  for (const mutation of [
    { name: "host-argv-replay", from: "const argv = [...invocation, ...args];", to: "const argv = [...process.argv.slice(0, 2), ...args];", pattern: "^regeneration model" },
    { name: "stdin-input-loss", from: "if (options.stdin === true)", to: "if (false)", pattern: "^stdin regeneration" },
    { name: "posix-only-windows-command", from: 'const shell = platform === "win32" ? "powershell" : "posix";', to: 'const shell = "posix";', pattern: "^win32 regeneration" },
    { name: "unnormalized-host-options", from: 'names.get(key.replace(/^--/, "").replace(/[-_]/g, "").toLowerCase())', to: "names.get(key)", pattern: "^canonical host option registry" },
    { name: "same-version-upgrade-attribution", from: "revisions.previous !== revisions.current && committed === previous()", to: "committed === previous()", pattern: "^same-version reorder" },
    { name: "unproved-upgrade-attribution", from: "revisions.previous !== revisions.current && committed === previous()", to: "revisions.previous !== revisions.current", pattern: "^same-version reorder" },
    { name: "detached-multiline-details", from: `    while (index + 1 < lines.length) {
      let next = index + 1;
      while (next < lines.length && lines[next]!.trim() === "") next++;
      if (next === lines.length || !/^(?: {2,}|\\t)\\S/.test(lines[next]!)) break;
      block.push(...lines.slice(index + 1, next + 1));
      index = next;
    }`, to: '    while (index + 1 < lines.length && /^(?: {2,}|\\t)\\S/.test(lines[index + 1]!)) block.push(lines[++index]!);', pattern: "^blank-separated multiline" },
  ]) {
    assert.ok(fixedDrift.includes(mutation.from), mutation.name);
    try {
      writeFileSync(driftFile, fixedDrift.replace(mutation.from, mutation.to));
      fails(mutation.pattern, 1);
      console.log(JSON.stringify({ mutation: mutation.name, reverted_fail: 1 }));
    } finally { writeFileSync(driftFile, fixedDrift); }
  }
  const facets = (await listAllComplete({}, { pmRoot })).items.find((item) => item.id === "pmc-total-item-order")!.change_facets;
  /** Write catalog mutations with the pinned CLI, retaining append-only history. */
  const setFacets = (value: unknown, id = "pmc-total-item-order"): void => {
    const result = spawnSync(resolve("node_modules/.bin/pm"), ["--path", pmRoot, "update", id, "--field", `change_facets=${JSON.stringify(value)}`], {
      cwd: scratch, encoding: "utf8", env: { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PM_AUTHOR: "codex-changelog339-1111", PM_TELEMETRY_SOURCE_CONTEXT: "automation", DO_NOT_TRACK: "1" },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  try {
    setFacets([]);
    fails("^package tracker catalog", 1);
    console.log(JSON.stringify({ mutation: "remove-2026-11-7-upgrade-action", reverted_fail: 1 }));
  } finally { setFacets(facets); }
  const catalog = (await listAllComplete({}, { pmRoot })).items;
  for (const id of ["pmc-contract-changes", "pmc-stable-itemless-check"]) {
    const originalFacets = catalog.find((item) => item.id === id)!.change_facets;
    try {
      setFacets([], id);
      fails("^every rendering-change item", 1);
      console.log(JSON.stringify({ mutation: `remove-catalog-action-${id}`, reverted_fail: 1 }));
    } finally { setFacets(originalFacets, id); }
  }
  mkdirSync(join(scratch, "scripts"));
  const baselineFile = join(scratch, "scripts/proof-baseline.ts");
  const fixedBaseline = readFileSync(resolve("scripts/proof-baseline.ts"), "utf8");
  try {
    const from = 'return { source: readFileSync(join(cwd, "src/cli.ts"), "utf8"), kind: "working-tree" };';
    assert.ok(fixedBaseline.includes(from));
    writeFileSync(baselineFile, fixedBaseline.replace(from, 'throw new Error("A Git base is required");'));
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^proof baseline falls back", "test/proof-baseline.test.ts"], { cwd: scratch, encoding: "utf8", timeout: 120000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /ERR_ASSERTION|AssertionError/);
    assert.match(result.stdout, /# fail 1\b/);
    console.log(JSON.stringify({ mutation: "unconditional-git-baseline", reverted_fail: 1 }));
  } finally { writeFileSync(baselineFile, fixedBaseline); }
  const restored = run();
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  assert.match(restored.stdout, new RegExp(`# pass ${passCount}\\b`));
  console.log(JSON.stringify({ fixed_pass: passCount, restored_pass: passCount, mutations: 15, reverted_fail: 17 }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
