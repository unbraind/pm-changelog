/** Prove issue 339 regressions reject behavioral reverts in an owned disposable package. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listAllComplete } from "@unbrained/pm-cli/sdk";

const scratch = mkdtempSync(join(tmpdir(), "pm-check-drift-revert-"));
try {
  for (const directory of ["src", "dist", "test"]) cpSync(resolve(directory), join(scratch, directory), { recursive: true });
  cpSync(resolve("package.json"), join(scratch, "package.json"));
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");
  const pmRoot = join(scratch, ".agents/pm");
  mkdirSync(join(pmRoot, "issues"), { recursive: true });
  mkdirSync(join(pmRoot, "history"));
  for (const file of ["settings.json", "issues/pmc-total-item-order.toon", "history/pmc-total-item-order.jsonl"]) cpSync(resolve(".agents/pm", file), join(pmRoot, file));
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
  const original = spawnSync("git", ["show", "origin/main:src/cli.ts"], { encoding: "utf8" });
  assert.equal(original.status, 0);
  /** Select only main, so every other fixed function remains in place. */
  const main = (source: string): string => {
    const start = source.indexOf("async function main(");
    assert.ok(start >= 0);
    return source.slice(start, source.indexOf("\n}", start) + 2);
  };
  try {
    writeFileSync(cli, fixedCli.replace(main(fixedCli), main(original.stdout)));
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
  const facets = (await listAllComplete({}, { pmRoot })).items.find((item) => item.id === "pmc-total-item-order")!.change_facets;
  /** Write catalog mutations with the pinned CLI, retaining append-only history. */
  const setFacets = (value: unknown): void => {
    const result = spawnSync(resolve("node_modules/.bin/pm"), ["--path", pmRoot, "update", "pmc-total-item-order", "--field", `change_facets=${JSON.stringify(value)}`], {
      cwd: scratch, encoding: "utf8", env: { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PM_AUTHOR: "codex-changelog339-1111", PM_TELEMETRY_SOURCE_CONTEXT: "automation", DO_NOT_TRACK: "1" },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  try {
    setFacets([]);
    fails("^package tracker catalog", 1);
    console.log(JSON.stringify({ mutation: "remove-2026-11-7-upgrade-action", reverted_fail: 1 }));
  } finally { setFacets(facets); }
  const restored = run();
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  assert.match(restored.stdout, new RegExp(`# pass ${passCount}\\b`));
  console.log(JSON.stringify({ fixed_pass: passCount, restored_pass: passCount, mutations: 5, reverted_fail: 7 }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
