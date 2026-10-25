/** Compare built baseline/current functions and CLI outputs on public tracker snapshots.
 * Usage: node test/sdk-adoption-differential.ts BASELINE_BUILD TRACKER_SNAPSHOT...
 * Supply tracker directories extracted from public git commits. No git is used
 * in the probes; copied source artifacts are read-only and hashed before/after.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Hash each source artifact and make it read-only; derived SDK caches are separate. */
function protect(root: string, prefix = ""): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) {
      for (const [file, hash] of protect(root, relative)) hashes.set(file, hash);
    } else {
      assert.equal(entry.isFile(), true, "public snapshots must contain only ordinary artifacts");
      hashes.set(relative, createHash("sha256").update(readFileSync(join(root, relative))).digest("hex"));
      chmodSync(join(root, relative), 0o444);
    }
  }
  return hashes;
}

/** Run the same static-import function probe against one built version. */
function probe(build: string, directory: string, pmRoot: string, env: NodeJS.ProcessEnv): string {
  const module = JSON.stringify(pathToFileURL(join(build, "dist", "generator.js")).href);
  const program = `import { readPmItems, parseListAllItemsJson, parsePmItemsJson, createChangelog } from ${module};
import { execFileSync } from "node:child_process";
const pmRoot = process.env.PM_PATH;
const items = readPmItems({ cwd: process.cwd(), pmRoot });
const envelope = JSON.parse(execFileSync(process.execPath, [process.env.DIFFERENTIAL_PM_CLI,
  "--pm-path", pmRoot, "--output-budget", "unbounded", "--output-limit", "unbounded",
  "list", "--all", "--full", "--strict-read", "--no-truncate", "--json"], {encoding:"utf8", maxBuffer:67108864}));
const parsed = parseListAllItemsJson(JSON.stringify(envelope));
const subset = parsePmItemsJson(JSON.stringify({ ...envelope, filters: { status: "closed" } }));
const generated = createChangelog({ items, version: "2026.10.25", date: "2026-10-25" });
console.log(JSON.stringify({items, parsed, subset, generated}));`;
  return execFileSync(process.execPath, ["--input-type=module", "--eval", program],
    { cwd: directory, env: { ...env, PM_PATH: pmRoot }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const [baselineArgument, ...snapshots] = process.argv.slice(2);
assert.ok(baselineArgument && snapshots.length > 0, "provide a baseline build and public tracker snapshots");
const baseline = resolve(baselineArgument);
const current = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "pm-changelog-differential-"));
try {
  for (const [index, snapshot] of snapshots.entries()) {
    const directory = join(scratch, String(index));
    const pmRoot = join(directory, ".agents", "pm");
    mkdirSync(dirname(pmRoot), { recursive: true });
    cpSync(resolve(snapshot), pmRoot, { recursive: true });
    const hashes = protect(pmRoot);
    const env = { ...process.env, PM_PATH: pmRoot, PM_GLOBAL_PATH: join(directory, "global-pm"),
      DO_NOT_TRACK: "1", GIT_CEILING_DIRECTORIES: scratch, PATH: "",
      DIFFERENTIAL_PM_CLI: join(current, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js") };
    const before = probe(baseline, directory, pmRoot, env);
    const after = probe(current, directory, pmRoot, env);
    assert.equal(after, before, "SDK functions must preserve complete public tracker outputs");
    const items = (JSON.parse(after) as { items: unknown[] }).items.length;
    const results: string[] = [];
    for (const format of [[], ["--format", "json"], ["--summary", "--format", "json"]]) {
      const args = ["--pm-root", pmRoot, "--stdout", "--version", "2026.10.25", "--date", "2026-10-25", ...format];
      const run = (build: string): string => execFileSync(process.execPath, [join(build, "dist", "cli.js"), ...args],
        { cwd: directory, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const oldOutput = run(baseline);
      assert.equal(run(current), oldOutput, "SDK CLI output must remain byte-identical");
      results.push(createHash("sha256").update(oldOutput).digest("hex"));
    }
    for (const [file, hash] of hashes) {
      assert.equal(createHash("sha256").update(readFileSync(join(pmRoot, file))).digest("hex"), hash,
        "read-only tracker artifacts must remain byte-identical");
    }
    console.log(JSON.stringify({ tracker: basename(dirname(dirname(snapshot))), items, function_comparison: "identical",
      cli_comparisons: 3, cli_sha256: results, unchanged_artifacts: hashes.size, git_available: false }));
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
