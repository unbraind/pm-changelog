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
  const run = () => spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=2", "test/markdown-retention.test.ts"], {
    cwd: scratch, encoding: "utf8", timeout: 60000,
    env: { PATH: process.env.PATH, DO_NOT_TRACK: "1" },
  });
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  assert.match(baseline.stdout, /# pass 6\b/);
  for (const mutation of [
    { name: "ignore-block-containers", from: 'const block = markdownContainerLine(markdown.slice(lineStart, contentEnd), containers, fence !== undefined);', to: 'const block = { content: markdown.slice(lineStart, contentEnd), containers: [], exited: false };' },
    { name: "keep-fence-after-container-exit", from: 'if (block.exited) fence = undefined;', to: 'if (false) fence = undefined;' },
    { name: "ignore-code-fences", from: '!wasFenced && !fence && containers.length === 0 && markdown.startsWith(marker, lineStart)', to: 'markdown.startsWith(marker, lineStart)' },
    { name: "fenced-publication-receipt", from: 'return findMarkdownHeadings(result.stdout, "##").some(({ heading: found }) => found === version || found.startsWith(`${version} - `));', to: 'return result.stdout.split(/\\r?\\n/).some((line) => line === `## ${version}` || line.startsWith(`## ${version} - `));' },
    { name: "trim-cleanup-slices", from: 'trimMarkdownStart(trimMarkdownEnd(part))', to: 'part.trim()' },
    { name: "trim-title-insertion", from: '${trimMarkdownStart(markdown)}', to: '${markdown.trimStart()}' },
    { name: "trim-after-title", from: 'trimMarkdownStart(trimMarkdownEnd(markdown.slice(titleEnd)))', to: 'markdown.slice(titleEnd).trim()' },
    { name: "trim-retained-boundary", from: 'trimMarkdownEnd(markdown.slice(0, start))', to: 'markdown.slice(0, start).trimEnd()' },
    { name: "trim-last-content-line", from: 'return markdown.slice(0, end);', to: 'return markdown.slice(0, end).trimEnd();' },
  ]) {
    assert.equal(fixed.split(mutation.from).length > 1, true, mutation.name);
    try {
      writeFileSync(file, fixed.replaceAll(mutation.from, mutation.to));
      const reverted = run();
      assert.equal(reverted.status, 1, reverted.stdout + reverted.stderr);
      assert.match(reverted.stdout, /ERR_ASSERTION|AssertionError/);
      const failures = [...reverted.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]);
      assert.ok(failures.length > 0);
      console.log(JSON.stringify({ mutation: mutation.name, fixed_pass: 6, reverted_fail: failures.length, failed_tests: failures }));
    } finally { writeFileSync(file, fixed); }
  }
  const restored = run();
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  assert.match(restored.stdout, /# pass 6\b/);
  console.log(JSON.stringify({ restored_pass: 6 }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
