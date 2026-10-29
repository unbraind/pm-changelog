/** Prove the regression detects a behavioral revert in a disposable copy only. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// CI passes no arguments and proves every case. Exact local rule filters save CPU; unknown rules refuse.
const selectedRules = process.argv.slice(2);
const testedRules = new Set<string>();
const scratch = mkdtempSync(join(tmpdir(), "pm-drift-revert-"));
try {
  for (const path of ["src", "dist"]) cpSync(resolve(path), join(scratch, path), { recursive: true });
  cpSync(resolve("package.json"), join(scratch, "package.json"));
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");
  mkdirSync(join(scratch, "test"));
  for (const testFile of ["agent-contract-drift.test.ts", "contract-report-closure.test.ts", "help-parser-contract.test.ts", "unicode-contract-output.test.ts"]) cpSync(resolve("test", testFile), join(scratch, "test", testFile));
  if (!selectedRules.length) {
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
  }
  /** Replace exactly one named function; all other fixed functions and schemas remain unchanged. */
  const functionText = (module: string, name: string): string => {
    const start = module.search(new RegExp(`(?:export )?function ${name}(?:<[^\\n]*>)?\\(`));
    const end = module.indexOf("\n}\n", start);
    assert.ok(start >= 0 && end > start);
    return module.slice(start, end + 3);
  };
  // Keep behavioral reverts self-contained: CI must also work after a squash merge
  // or when the verifier runs from an archived source checkout without git history.
  for (const mutant of [
    { file: "agent-contract-drift.ts", name: "formatAgentContractDrift", rule: "producer bounds", match: "^producer closure:",
      revert: (body: string) => body.replaceAll("MAX_AGGREGATE_EVIDENCE", "MAX_ROWS").replaceAll("MAX_OMISSIONS", "MAX_ROWS").replaceAll("Number.MAX_SAFE_INTEGER", "1024") },
    { file: "agent-contract-drift.ts", name: "buildAgentContractDrift", rule: "scope before validation", match: "^release scope:",
      revert: (body: string) => body.replace('    if (isContractReleaseAfter(release.heading, range.to)) continue;\n', "")
        .replace('        if (!version)', '        if (version && isContractReleaseAfter(release.heading, range.to)) continue;\n        if (!version)') },
    { file: "agent-contract-drift.ts", name: "buildAgentContractDrift", rule: "orphan provenance", match: "^producer closure: orphan",
      revert: (body: string) => body.replace('for (const source of entry.sources) omissions.push({ ...source, reason: "orphan_removal" });',
        'omissions.push({ ...entry.sources[0], item: [...entry.items].sort()[0], reason: "orphan_removal" });') },
    { file: "agent-contract-drift.ts", name: "buildAgentContractDrift", rule: "baseline replay validates every removal", match: "^baseline replay:",
      revert: (body: string) => body.replace('      apply(id, entry);', '      if (entry.declaration.removed) active.delete(id); else active.set(id, entry);') },
    { file: "agent-contract-drift.ts", name: "buildAgentContractDrift", rule: "interval replay validates every removal", match: "^baseline replay:",
      revert: (body: string) => body.replace('      if (!apply(id, entry)) continue;',
        '      if (entry.declaration.removed && !previous) continue;\n      apply(id, entry);') },
    { file: "audience-contracts.ts", name: "buildAudienceContracts", rule: "bounded facet selection", match: "^release scope:",
      revert: (body: string) => body.replace('    if (options.untilVersion !== undefined && isContractReleaseAfter(release.heading, options.untilVersion)) continue;\n', "") },
    { file: "consumer-upgrades.ts", name: "buildConsumerUpgrades", rule: "bounded upgrade selection", match: "^release scope:",
      revert: (body: string) => body.replace(', untilVersion: to', '') },
    { file: "contract-versions.ts", name: "isContractReleaseAfter", rule: "heading scope uses generator identity", match: "^release headings:",
      revert: (body: string) => body.replace('parseContractReleaseHeading(value)', 'parseContractRelease(value)') },
    { file: "generator.ts", name: "sectionVersionKey", rule: "lower bounds use heading identity", match: "^release headings:",
      revert: (body: string) => body.replace('const version = normalizeReleaseHeadingKey(heading);',
        'const separatorStart = findReleaseSeparatorStart(heading);\n  const version = heading.slice(0, separatorStart ?? heading.length).trim();') },
    { file: "contract-versions.ts", name: "parseContractReleaseHeading", rule: "heading interpretation uses generator identity", match: "^release headings:",
      revert: (body: string) => body.replace('parseContractRelease(normalizeReleaseHeadingKey(value))', 'parseContractRelease(value)') },
    { file: "agent-contract-drift.ts", name: "buildAgentContractDrift", rule: "drift observation uses heading identity", match: "^release headings:",
      revert: (body: string) => body.replace('parseContractReleaseHeading(release.heading)', 'releaseVersion(release.heading)') },
    { file: "consumer-upgrades.ts", name: "buildConsumerUpgrades", rule: "upgrade attribution uses heading identity", match: "^release headings:",
      revert: (body: string) => body.replace('version(parseContractReleaseHeading(row.release))', 'version(row.release)') },
    { file: "generator.ts", name: "normalizeReleaseHeadingKey", rule: "stored releases share generator zero-padding identity", match: "^release padding:",
      revert: (body: string) => body.replace('return normalizeReleaseKey(fallback);', 'return fallback.trim().replace(/^v/i, "").toLowerCase();') },
    { file: "output-unicode.ts", name: "normalizeUnicodeText", rule: "well-formed Unicode at every text boundary", match: "^Unicode boundary:", testFile: "unicode-contract-output.test.ts",
      revert: (body: string) => body.replace('return toUSVString(value);', 'return value;') },
    { file: "output-unicode.ts", name: "normalizeUnicodeOutput", rule: "wire Unicode normalization", match: "^Unicode boundary:", testFile: "unicode-contract-output.test.ts",
      revert: (_body: string) => 'export function normalizeUnicodeOutput<T>(value: T): T {\n  return value;\n}\n' },
    { file: "agent-contract-drift.ts", name: "text", rule: "declaration Unicode producer agreement", match: "^Unicode boundary:", testFile: "unicode-contract-output.test.ts",
      revert: (body: string) => body.replace('return normalizeUnicodeText(value);', 'return value;') },
    { file: "audience-contracts.ts", name: "readFacets", rule: "audience Unicode producer agreement", match: "^Unicode boundary:", testFile: "unicode-contract-output.test.ts",
      revert: (body: string) => body.replace('text: normalizeUnicodeText(row.text)', 'text: row.text') },
    { file: "upgrade-actions.ts", name: "parseUpgradeActions", rule: "upgrade Unicode producer agreement", match: "^Unicode boundary:", testFile: "unicode-contract-output.test.ts",
      revert: (body: string) => body.replace('normalizeUnicodeText(row.title)', 'row.title').replace('normalizeUnicodeText(row.body as string)', 'row.body as string') },
    { file: "claim-audit.ts", name: "formatClaimAudit", rule: "audit TOON escaping", match: "^Unicode boundary:", testFile: "unicode-contract-output.test.ts",
      revert: (body: string) => body.replace('encodeUnicodeOutput({ markdown_sha256: report.markdown_sha256 })', '`markdown_sha256: ${report.markdown_sha256}`')
        .replace('typeof value === "string" ? `"${escapeString(value)}"` : JSON.stringify(value)', 'JSON.stringify(value)') },
    { file: "extension.ts", name: "renderedCommandResult", rule: "host Unicode wire boundary", match: "^Unicode boundary:", testFile: "unicode-contract-output.test.ts",
      revert: (body: string) => body.replace('stringifyUnicodeOutput(value, 2)', 'JSON.stringify(value, null, 2)') },
    { file: "generator.ts", name: "formatBodyPreview", rule: "Unicode-safe preview truncation", match: "^Unicode boundary:", testFile: "unicode-contract-output.test.ts",
      revert: (body: string) => body.replace('const characters = Array.from(body);\n  const truncated = characters.length > limit ? `${characters.slice(0, limit).join("")}…` : body;',
        'const truncated = body.length > limit ? `${body.slice(0, limit)}…` : body;') },
    { file: "release-context.ts", name: "formatDate", rule: "Unicode-safe fallback date truncation", match: "^Unicode boundary:", testFile: "unicode-contract-output.test.ts",
      revert: (body: string) => body.replace('Array.from(normalizeUnicodeText(timestamp)).slice(0, 10).join("")', 'timestamp.slice(0, 10)') },
    { file: "generator.ts", name: "encodeItemPathSegment", rule: "Unicode-safe link encoding", match: "^Unicode boundary:", testFile: "unicode-contract-output.test.ts",
      revert: (body: string) => body.replace('encodeURIComponent(normalizeUnicodeText(segment))', 'encodeURIComponent(segment)') },
    { file: "agent-contract-drift.ts", name: "buildAgentContractDrift", rule: "Unicode captured drift status identity", match: "^Unicode boundary:", testFile: "unicode-contract-output.test.ts",
      revert: (body: string) => body.replace('normalizeUnicodeOutput(new Map(options.statusSelection))', 'new Map(options.statusSelection)') },
    { file: "audience-contracts.ts", name: "buildAudienceContracts", rule: "Unicode captured audience status identity", match: "^Unicode boundary:", testFile: "unicode-contract-output.test.ts",
      revert: (body: string) => body.replace('normalizeUnicodeOutput(new Map(options.statusSelection))', 'new Map(options.statusSelection)') },
    { file: "cli.ts", name: "printHelp", rule: "parser help agreement", match: "root .* synopsis", testFile: "help-parser-contract.test.ts",
      revert: (body: string) => body.replace('        [--pm-root path] [--json] [-h|--help]\n', '')
        .replace('corrections view --release name --item id [--pm-root path] [--format toon|json] [--json] [-h|--help]',
          'corrections view --release name --item id [--pm-root path] [--format toon|json] [--json]') },
  ]) {
    if (selectedRules.length && !selectedRules.includes(mutant.rule)) continue;
    testedRules.add(mutant.rule);
    const path = join(scratch, "src", mutant.file), fixed = readFileSync(path, "utf8");
    const fixedFunction = functionText(fixed, mutant.name), revertedFunction = mutant.revert(fixedFunction);
    assert.notEqual(revertedFunction, fixedFunction, `${mutant.rule} must actually restore the old behavior`);
    const args = ["--test", "--test-concurrency=2", `--test-name-pattern=${mutant.match}`, `test/${mutant.testFile ?? "contract-report-closure.test.ts"}`];
    const options = { cwd: scratch, encoding: "utf8" as const, env: { PATH: process.env.PATH, DO_NOT_TRACK: "1" }, timeout: 180000 };
    const fixedResult = spawnSync(process.execPath, args, options);
    assert.equal(fixedResult.status, 0, fixedResult.stdout + fixedResult.stderr);
    assert.match(fixedResult.stdout, /tests [1-9]/);
    try {
      writeFileSync(path, fixed.replace(fixedFunction, revertedFunction));
      const reverted = spawnSync(process.execPath, args, options);
      assert.notEqual(reverted.status, 0, `${mutant.name} must fail on behavioral revert`);
      assert.match(reverted.stdout + reverted.stderr, /AssertionError|ERR_ASSERTION/);
    } finally { writeFileSync(path, fixed); }
    const restoredResult = spawnSync(process.execPath, args, options);
    assert.equal(restoredResult.status, 0, restoredResult.stdout + restoredResult.stderr);
    assert.match(restoredResult.stdout, /tests [1-9]/);
    console.log(JSON.stringify({ function: mutant.name, rule: mutant.rule, fixed_pass: true, behavioral_revert_fail: true, restored_pass: true, pure_source_tests: true }));
  }
  assert.ok(selectedRules.every((rule) => testedRules.has(rule)), "Every explicitly selected revert rule must exist and execute");
} finally { rmSync(scratch, { recursive: true, force: true }); }
