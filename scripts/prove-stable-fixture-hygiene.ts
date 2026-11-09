/** Reject stale packed code and redirected fixture commands using disposable copies. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pm-stable-hygiene-proof-"));
try {
  for (const file of ["src", "scripts", "test", "dist", "docs", "README.md", "CHANGELOG.md", "package.json", "manifest.json", "tsconfig.json"]) {
    cpSync(resolve(file), join(scratch, file), { recursive: true });
  }
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");
  const env = { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", NPM_CONFIG_USERCONFIG: devNull, DO_NOT_TRACK: "1" };
  for (const mutation of [
    { name: "inherited-repository-location", file: "test/git-fixture.ts", from: "Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX)$/i.test(key)))", to: "process.env", args: ["--test", "--test-concurrency=2", "test/git-fixture.test.ts"], failure: /ERR_ASSERTION/ },
    { name: "redirected-alias-check", file: "test/git-fixture.ts", from: '{ cwd: directory, env, encoding: "utf8" }', to: '{ cwd: directory, encoding: "utf8" }', args: ["--test", "--test-concurrency=2", "test/git-fixture.test.ts"], failure: /ERR_ASSERTION/ },
    { name: "redirected-alias-write", file: "test/git-fixture.ts", from: '{ cwd: directory, env, stdio: "pipe" }', to: '{ cwd: directory, stdio: "pipe" }', args: ["--test", "--test-concurrency=2", "test/git-fixture.test.ts"], failure: /ERR_ASSERTION/ },
    { name: "stale-packed-dist", file: "scripts/accept-stable-review.ts", from: '  run("npm", ["run", "build"], repository);\n', to: "", args: ["scripts/accept-stable-review.ts"], failure: /stale-packed-code/ },
  ]) {
    const file = join(scratch, mutation.file), original = readFileSync(file, "utf8");
    assert.ok(original.includes(mutation.from), mutation.name);
    /** Poison only the disposable emitted CLI; rebuilding must remove this failure. */
    const run = () => {
      if (mutation.name === "stale-packed-dist") writeFileSync(join(scratch, "dist/cli.js"), 'throw new Error("stale-packed-code");\n');
      return spawnSync(process.execPath, mutation.args, { cwd: scratch, env, encoding: "utf8", timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
    };
    const fixed = run();
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
    try {
      writeFileSync(file, original.replace(mutation.from, mutation.to));
      const reverted = run();
      assert.equal(reverted.status, 1, reverted.stdout + reverted.stderr);
      assert.match(reverted.stdout + reverted.stderr, mutation.failure);
    } finally { writeFileSync(file, original); }
    const restored = run();
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    console.log(JSON.stringify({ mutation: mutation.name, fixed_pass: true, reverted_fail: true, restored_pass: true }));
    if (mutation.name === "stale-packed-dist") console.log(restored.stdout.trim());
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
