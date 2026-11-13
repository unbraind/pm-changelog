/** Prove each Markdown retention fix rejects its behavioral revert in an owned copy. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pm-markdown-revert-"));
try {
  for (const directory of ["src", "test"]) cpSync(resolve(directory), join(scratch, directory), { recursive: true });
  cpSync(resolve("package.json"), join(scratch, "package.json"));
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");
  const file = join(scratch, "src/generator.ts");
  const fixed = readFileSync(file, "utf8");
  const run = (performance = false) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=2",
    ...(performance ? ["--experimental-test-coverage", "--test-coverage-include=src/generator.ts", "--test-name-pattern=hostile", "test/generator-redos.test.ts"] : ["test/markdown-retention.test.ts"])], {
    cwd: scratch, encoding: "utf8", timeout: 60000,
    env: { PATH: process.env.PATH, DO_NOT_TRACK: "1" },
  });
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  assert.match(baseline.stdout, /# pass 8\b/);
  const performanceBaseline = run(true);
  assert.equal(performanceBaseline.status, 0, performanceBaseline.stdout + performanceBaseline.stderr);
  assert.match(performanceBaseline.stdout, /# pass 5\b/);
  for (const mutation of [
    { name: "list-before-thematic-break", from: 'if (thematicBreakStart !== undefined && cursor >= thematicBreakStart && isMarkdownThematicBreak(line, cursor)) break;', to: 'if (false) break;', performance: false },
    { name: "unbounded-container-nesting", from: 'next.length < MAX_MARKDOWN_CONTAINER_DEPTH', to: 'next.length < Infinity', performance: true },
    { name: "rescan-blank-containers", from: 'if (/^ *$/.test(line)) {', to: 'if (false) {', performance: true },
    { name: "rescan-rejected-thematic-suffixes", from: 'const thematicBreakStart = findMarkdownThematicSuffixStart(line);', to: 'const thematicBreakStart = 0;', performance: true },
    { name: "ignore-block-containers", from: ': markdownContainerLine(markdown.slice(lineStart, contentEnd), containers, fence !== undefined, paragraph);', to: ': { content: markdown.slice(lineStart, contentEnd), containers: [], exited: false };' },
    { name: "drop-lazy-container-context", from: '!fenced && paragraph && isMarkdownParagraphLine(line.slice(cursor))', to: '!fenced && false && isMarkdownParagraphLine(line.slice(cursor))' },
    { name: "keep-fence-after-container-exit", from: 'if (block.exited) fence = undefined;', to: 'if (false) fence = undefined;' },
    { name: "ignore-code-fences", from: '!wasFenced && !fence && containers.length === 0 && markdown.startsWith(marker, lineStart)', to: 'markdown.startsWith(marker, lineStart)' },
    { name: "fenced-publication-receipt", from: 'return findMarkdownHeadings(result.stdout, "##").some(({ heading: found }) => found === version || found.startsWith(`${version} - `));', to: 'return result.stdout.split(/\\r?\\n/).some((line) => line === `## ${version}` || line.startsWith(`## ${version} - `));' },
    { name: "trim-cleanup-slices", from: 'trimMarkdownStart(trimMarkdownEnd(part))', to: 'part.trim()' },
    { name: "trim-title-insertion", from: '${trimMarkdownStart(markdown, renderingVersion)}', to: '${markdown.trimStart()}' },
    { name: "trim-after-title", from: 'trimMarkdownStart(trimMarkdownEnd(markdown.slice(titleEnd)), renderingVersion)', to: 'markdown.slice(titleEnd).trim()' },
    { name: "trim-retained-boundary", from: 'trimMarkdownEnd(markdown.slice(0, start), renderingVersion)', to: 'markdown.slice(0, start).trimEnd()' },
    { name: "trim-last-content-line", from: 'return markdown.slice(0, end);', to: 'return markdown.slice(0, end).trimEnd();' },
  ]) {
    assert.equal(fixed.split(mutation.from).length > 1, true, mutation.name);
    try {
      writeFileSync(file, fixed.replaceAll(mutation.from, mutation.to));
      const reverted = run(mutation.performance);
      assert.equal(reverted.status, 1, reverted.stdout + reverted.stderr);
      assert.match(reverted.stdout, /ERR_ASSERTION|AssertionError|wall watchdog|CPU; budget/);
      const failures = [...reverted.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]);
      assert.ok(failures.length > 0);
      console.log(JSON.stringify({ mutation: mutation.name, fixed_pass: mutation.performance ? 5 : 8, reverted_fail: failures.length, failed_tests: failures }));
    } finally { writeFileSync(file, fixed); }
  }
  const restored = run();
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  assert.match(restored.stdout, /# pass 8\b/);
  const performanceRestored = run(true);
  assert.equal(performanceRestored.status, 0, performanceRestored.stdout + performanceRestored.stderr);
  assert.match(performanceRestored.stdout, /# pass 5\b/);
  console.log(JSON.stringify({ restored_pass: 8, performance_restored_pass: 5 }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
