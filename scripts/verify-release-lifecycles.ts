/** Prove both ownership regressions behaviorally in disposable CI copies, then rerun the fixed model. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pm-lifecycle-reverts-"));
// CI supplies a disposable runner. No caller credentials are passed to a test or compiler.
const childEnv = { PATH: process.env.PATH, HOME: join(scratch, "home"), DO_NOT_TRACK: "1", GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: tmpdir(), NPM_CONFIG_USERCONFIG: devNull };
try {
  for (const name of ["src", "test", "dist"]) cpSync(join(repository, name), join(scratch, name), { recursive: true });
  for (const name of ["package.json", "tsconfig.json", "tsconfig.test.json", "manifest.json"]) cpSync(join(repository, name), join(scratch, name));
  symlinkSync(join(repository, "node_modules"), join(scratch, "node_modules"), "junction");
  const path = join(scratch, "src/milestones.ts");
  const original = readFileSync(path, "utf8");
  const admission = 'const published = new Set(visibleChangelogItems({ items: [...milestone.items], ...context }).map((item) => item.id!));';
  const eligibility = original.split("\n").find((line) => line.trim().startsWith("const eligible = new Set(milestone.schema === 2"));
  assert.ok(eligibility); assert.ok(original.includes(admission));
  const mutants = [
    { name: "omitted captures reserve ownership", source: original.replace(admission, "const published = new Set(eligible);") },
    { name: "mutable current roles reinterpret history", source: original.replace(eligibility, "    const eligible = new Set(doneIds(milestone.items, _registry ?? resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema)));") },
  ];
  for (const mutant of mutants) {
    try {
      writeFileSync(path, mutant.source);
      execFileSync(process.execPath, [join(scratch, "node_modules/typescript/bin/tsc")], { cwd: scratch, env: childEnv, stdio: "pipe" });
      const result = spawnSync(process.execPath, ["--test", "--test-concurrency=2", "--test-name-pattern=500 seeded native lifecycles", "test/release-lifecycles.test.ts"], { cwd: scratch, env: childEnv, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      assert.notEqual(result.status, 0, `${mutant.name} unexpectedly passed`);
      assert.match(result.stdout + result.stderr, /ERR_ASSERTION|AssertionError/, `${mutant.name} must fail a behavioral assertion`);
      console.log(JSON.stringify({ mutant: mutant.name, behavioral_failure: true }));
    } finally {
      writeFileSync(path, original);
      execFileSync(process.execPath, [join(scratch, "node_modules/typescript/bin/tsc")], { cwd: scratch, env: childEnv, stdio: "pipe" });
    }
    assert.equal(readFileSync(path, "utf8"), original);
  }
  execFileSync(process.execPath, ["--test", "--test-concurrency=2", "--test-name-pattern=500 seeded native lifecycles", "test/release-lifecycles.test.ts"], { cwd: scratch, env: childEnv, stdio: "inherit" });
  console.log(JSON.stringify({ restored: true, fixed_model_passed: true }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
