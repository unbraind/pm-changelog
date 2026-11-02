/** Run each consumer's own full-changelog check with this build in disposable origin/main clones. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pm-itemless-fleet-"));
const build = join(scratch, "build");
const results: { up_to_date: boolean }[] = [];
try {
  cpSync(resolve("dist"), build, { recursive: true });
  const buildSha256 = createHash("sha256").update(readFileSync(join(build, "generator.js"))).update(readFileSync(join(build, "cli.js"))).digest("hex");
  console.log(JSON.stringify({ build_sha256: buildSha256 }));
  for (const repo of ["pm-beads", "pm-jira", "pm-context", "pm-slack", "pm-starter"]) {
    const cwd = join(scratch, repo);
    /** Keep subprocess diagnostics in memory; public receipts contain only relative command names. */
    const run = (command: string, args: string[], directory: string) => {
      const result = spawnSync(command, args, { cwd: directory, encoding: "utf8", timeout: 720000,
        env: { ...process.env, DO_NOT_TRACK: "1" }, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(result.status, 0, `${repo}: ${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    run("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "clone", "--quiet", "--branch", "main", "--single-branch", `https://github.com/unbraind/${repo}.git`, cwd], scratch);
    // Include orphaned release tags too, as the consumers' all-tag generator does.
    run("git", ["fetch", "--quiet", "origin", "--tags"], cwd);
    const head = run("git", ["rev-parse", "origin/main"], cwd).trim();
    assert.equal(run("git", ["rev-parse", "HEAD"], cwd).trim(), head);
    console.log(JSON.stringify({ repo, head, phase: "installing exact consumer dependencies" }));
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd);
    const baseline = spawnSync("npm", ["run", "changelog:full", "--", "--check"], { cwd, encoding: "utf8", timeout: 720000,
      env: { ...process.env, DO_NOT_TRACK: "1" }, maxBuffer: 16 * 1024 * 1024 });
    console.log(JSON.stringify({ repo, baseline_status: baseline.status, baseline_up_to_date: /Changelog is up to date/.test(baseline.stdout + baseline.stderr) }));
    const target = join(cwd, "node_modules/pm-changelog/dist");
    // Both paths are owned disposable data; no consumer checkout or remote is mutated.
    rmSync(target, { recursive: true, force: true });
    cpSync(build, target, { recursive: true });
    // npm marks bins executable during install; retain that after replacing dist.
    chmodSync(join(target, "cli.js"), 0o755);
    const before = readFileSync(join(cwd, "CHANGELOG.md"));
    const checked = spawnSync("npm", ["run", "changelog:full", "--", "--check"], { cwd, encoding: "utf8", timeout: 720000,
      env: { ...process.env, DO_NOT_TRACK: "1" }, maxBuffer: 16 * 1024 * 1024 });
    const upToDate = checked.status === 0 && /Changelog is up to date/.test(checked.stdout + checked.stderr);
    assert.deepEqual(readFileSync(join(cwd, "CHANGELOG.md")), before);
    assert.equal(run("git", ["diff", "--", "CHANGELOG.md"], cwd), "");
    const receipt = { repo, head, command: "npm run changelog:full -- --check", status: checked.status,
      up_to_date: upToDate, error_code: (checked.stdout + checked.stderr).match(/"code":"([A-Z_]+)"/)?.[1],
      added_headings: [...(checked.stdout + checked.stderr).matchAll(/^\+## ([^\r\n]+)/gm)].map((match) => match[1]),
      working_file_unchanged: true, build_sha256: buildSha256, changelog_sha256: createHash("sha256").update(before).digest("hex") };
    results.push(receipt);
    console.log(JSON.stringify(receipt));
  }
  assert.equal(results.length, 5);
  const passed = results.filter((result) => result.up_to_date).length;
  console.log(JSON.stringify({ consumers: results.length, passed, unchanged_working_files: results.length, remote_writes: 0 }));
  assert.equal(passed, 5, "Every consumer must report up to date");
} finally { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
