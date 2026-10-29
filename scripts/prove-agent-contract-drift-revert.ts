/** Prove the regression detects a behavioral revert in a disposable copy only. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pm-drift-revert-"));
try {
  for (const path of ["src", "dist"]) cpSync(resolve(path), join(scratch, path), { recursive: true });
  cpSync(resolve("package.json"), join(scratch, "package.json"));
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");
  mkdirSync(join(scratch, "test")); cpSync(resolve("test/agent-contract-drift.test.ts"), join(scratch, "test/agent-contract-drift.test.ts"));
  const source = join(scratch, "src/agent-contract-drift.ts"), original = readFileSync(source, "utf8");
  const pattern = /export function buildAgentContractDrift\(options: AgentContractDriftOptions\): AgentContractDriftReport \{[\s\S]*?\n\}\n\n\/\*\* Certified/;
  assert.match(original, pattern);
  /** Capture only pass/fail: no scratch paths or private child environment are emitted. */
  const run = () => spawnSync(process.execPath, ["--test", "--test-concurrency=2", "--test-name-pattern=ten releases", "test/agent-contract-drift.test.ts"], {
    cwd: scratch, encoding: "utf8", env: { PATH: process.env.PATH, DO_NOT_TRACK: "1" }, timeout: 120000,
  });
  assert.equal(run().status, 0);
  try {
    writeFileSync(source, original.replace(pattern, 'export function buildAgentContractDrift(options: AgentContractDriftOptions): AgentContractDriftReport {\n  return { schema_version: 1, from: options.from, to: options.to, complete: true, definitions: [], baseline: [], changes: [], unchanged: [], omissions: [] };\n}\n\n/** Certified'));
    const reverted = run(); assert.notEqual(reverted.status, 0); assert.match(reverted.stdout + reverted.stderr, /AssertionError|ERR_ASSERTION/);
  } finally { writeFileSync(source, original); }
  assert.equal(run().status, 0);
  console.log(JSON.stringify({ fixed_pass: 1, behavioral_revert_fail: 1, restored_pass: 1, disposable_copy: true }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
