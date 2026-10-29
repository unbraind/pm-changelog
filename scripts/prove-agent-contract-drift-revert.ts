/** Prove the regression detects a behavioral revert in a disposable copy only. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pm-drift-revert-"));
try {
  for (const path of ["src", "dist"]) cpSync(resolve(path), join(scratch, path), { recursive: true });
  cpSync(resolve("package.json"), join(scratch, "package.json"));
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");
  mkdirSync(join(scratch, "test"));
  for (const testFile of ["agent-contract-drift.test.ts", "contract-report-closure.test.ts"]) cpSync(resolve("test", testFile), join(scratch, "test", testFile));
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
  /** Replace exactly one exported function; all other fixed functions and schemas remain unchanged. */
  const functionText = (module: string, name: string): string => {
    const start = module.indexOf(`export function ${name}(`);
    const end = module.indexOf("\n}\n", start);
    assert.ok(start >= 0 && end > start);
    return module.slice(start, end + 3);
  };
  const baseline = "497f4c36c78920363bb72e54280410dbec902eac";
  for (const mutant of [
    { file: "agent-contract-drift.ts", name: "formatAgentContractDrift", match: "^producer closure:" },
    { file: "agent-contract-drift.ts", name: "buildAgentContractDrift", match: "release scope:|producer closure: orphan" },
    { file: "audience-contracts.ts", name: "buildAudienceContracts", match: "release scope:" },
    { file: "consumer-upgrades.ts", name: "buildConsumerUpgrades", match: "release scope:" },
  ]) {
    const path = join(scratch, "src", mutant.file), fixed = readFileSync(path, "utf8");
    const prior = execFileSync("git", ["show", `${baseline}:src/${mutant.file}`], { encoding: "utf8", env: { PATH: process.env.PATH } });
    const args = ["--test", "--test-concurrency=2", `--test-name-pattern=${mutant.match}`, "test/contract-report-closure.test.ts"];
    const options = { cwd: scratch, encoding: "utf8" as const, env: { PATH: process.env.PATH, DO_NOT_TRACK: "1" }, timeout: 180000 };
    const fixedResult = spawnSync(process.execPath, args, options);
    assert.equal(fixedResult.status, 0, fixedResult.stdout + fixedResult.stderr);
    assert.match(fixedResult.stdout, /tests [1-9]/);
    try {
      writeFileSync(path, fixed.replace(functionText(fixed, mutant.name), functionText(prior, mutant.name)));
      const reverted = spawnSync(process.execPath, args, options);
      assert.notEqual(reverted.status, 0, `${mutant.name} must fail on behavioral revert`);
      assert.match(reverted.stdout + reverted.stderr, /AssertionError|ERR_ASSERTION/);
    } finally { writeFileSync(path, fixed); }
    const restoredResult = spawnSync(process.execPath, args, options);
    assert.equal(restoredResult.status, 0, restoredResult.stdout + restoredResult.stderr);
    assert.match(restoredResult.stdout, /tests [1-9]/);
    console.log(JSON.stringify({ function: mutant.name, fixed_pass: true, behavioral_revert_fail: true, restored_pass: true, pure_source_tests: true }));
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
