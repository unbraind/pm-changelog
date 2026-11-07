/** Prove contract review regressions fail under isolated behavioral reverts. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pm-contract-revert-"));
try {
  for (const path of ["src", "dist", "package.json", "manifest.json", "tsconfig.json"]) {
    cpSync(resolve(path), join(scratch, path), { recursive: true });
  }
  mkdirSync(join(scratch, "test"));
  mkdirSync(join(scratch, "home"));
  for (const file of ["contract-changes.test.ts", "contract-projections.test.ts", "contract-audit-eligibility.test.ts"]) cpSync(resolve("test", file), join(scratch, "test", file));
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");
  const childEnv = { PATH: process.env.PATH, HOME: join(scratch, "home"), NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", DO_NOT_TRACK: "1" };
  /** Execute only the matching regression with no inherited credentials or tracker. */
  const run = (pattern: string, testFile: string) => spawnSync(process.execPath, ["--test", "--test-concurrency=2", `--test-name-pattern=${pattern}`, `test/${testFile}`], {
    cwd: scratch, encoding: "utf8", env: childEnv, timeout: 120000,
  });
  /** Rebuild the copied extension so activation tests exercise the mutated artifact. */
  const build = () => {
    const result = spawnSync(process.execPath, [resolve("node_modules/typescript/bin/tsc")], { cwd: scratch, encoding: "utf8", env: childEnv, timeout: 120000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  for (const proof of [
    { rule: "active-extension update registration", path: "src/extension.ts", pattern: "^active extension runUpdate", rebuild: true,
      from: ', { name: "contract_change", type: "object", optional: true }', to: "" },
    { rule: "neutral closure eligibility", path: "src/contract-changes.ts", pattern: "^declared issues without repair", rebuild: false,
      from: "return needsNeutralClosure(item, context) ? undefined : readContractChange(item);", to: "return readContractChange(item);" },
    { rule: "JSON neutral projection", path: "src/generator.ts", pattern: "^declared issues without repair", rebuild: false,
      from: "const contract = readPresentedContractChange(item, options);", to: "const contract = readContractChange(item);" },
    { rule: "summary neutral title", path: "src/generator.ts", pattern: "^declared issues without repair", rebuild: false,
      from: "title: resolveEntryTitle(item, options),", to: "title: readContractChange(item) ? item.title : resolveEntryTitle(item, options)," },
    { rule: "field grouping closure precedence", path: "src/generator.ts", pattern: "^declared issues without repair", rebuild: false,
      from: "if (readPresentedContractChange(item, context)) {", to: "if (readContractChange(item)) {" },
    { rule: "category grouping closure precedence", path: "src/generator.ts", pattern: "^declared issues without repair", rebuild: false,
      from: 'const category = readPresentedContractChange(item, context) ? "Changed (SDK contract)" : classifyItem(item, context);', to: 'const category = readContractChange(item) ? "Changed (SDK contract)" : classifyItem(item, context);' },
    { rule: "contract field isolation", path: "src/generator.ts", pattern: "^contract Markdown isolates", rebuild: false,
      from: "    : escapeItemTitleMarkdown(resolveEntryTitle(item, options));", to: '    : escapeItemTitleMarkdown(resolveEntryTitle(item, options));\n  const merged = contract ? escapeItemTitleMarkdown(toSingleLine(`${item.title}: ${contract.before || "[missing before]"} → ${contract.after || "[missing after]"}. Migrate: ${contract.migrate || "[missing migration]"}`)) : title;' },
    { rule: "complete equal backtick runs", path: "src/generator.ts", pattern: "^contract Markdown isolates", rebuild: false,
      from: "return escapeItemTitleMarkdown(toSingleLine(value), true);", to: "return escapeItemTitleMarkdown(toSingleLine(value));" },
    { rule: "unmatched opening run recovery", path: "src/generator.ts", pattern: "^contract Markdown isolates", rebuild: false,
      from: "if (matchFullFences) {\n        result += escapeItemTitleText(fence);", to: "if (false) {\n        result += escapeItemTitleText(fence);" },
    { rule: "nullish metadata precedence", path: "src/contract-changes.ts", pattern: "^contract projection: nullish", testFile: "contract-projections.test.ts", rebuild: false,
      from: "const value = (direct === undefined || direct === null) && nested !== undefined ? nested : direct;", to: "const value = direct !== undefined ? direct : nested;" },
    { rule: "summary title projection", path: "src/generator.ts", pattern: "^contract projection: every presentation", testFile: "contract-projections.test.ts", rebuild: false,
      from: "title: resolveEntryTitle(item, options),", to: "title: readPresentedContractChange(item, options) ? item.title : resolveEntryTitle(item, options)," },
    { rule: "document title projection", path: "src/generator.ts", pattern: "^contract projection: every presentation", testFile: "contract-projections.test.ts", rebuild: false,
      from: "...(contract ? { contract_change: contract } : {}),\n    id: item.id,\n    title: resolveEntryTitle(item, options),", to: "...(contract ? { contract_change: contract } : {}),\n    id: item.id,\n    title: contract ? item.title : resolveEntryTitle(item, options)," },
    { rule: "shared entry-source policy", path: "src/generator.ts", pattern: "^contract projection: every presentation", testFile: "contract-projections.test.ts", rebuild: false,
      from: "  if (readPresentedContractChange(item, options)) return toSingleLine(item.title);\n", to: "" },
    { rule: "summary formatter line boundary", path: "src/generator.ts", pattern: "^contract projection: summary formatter", testFile: "contract-projections.test.ts", rebuild: false,
      from: "return toSingleLine(`[${versionLabel}] ${entry.category}: ${entry.title}${idSuffix}`);", to: "return `[${versionLabel}] ${entry.category}: ${entry.title}${idSuffix}`;" },
    { rule: "audit only published contract declarations", path: "src/claim-audit.ts", pattern: "^contract audit: only published", testFile: "contract-audit-eligibility.test.ts", rebuild: false,
      from: "const contract = readPresentedContractChange(item, options);", to: "const contract = readContractChange(item);" },
    { rule: "audit preserves presentation context", path: "src/claim-audit.ts", pattern: "^contract audit: only published", testFile: "contract-audit-eligibility.test.ts", rebuild: false,
      from: "const contract = readPresentedContractChange(item, options);", to: "const contract = readPresentedContractChange(item, {});" },
  ]) {
    const testFile = ("testFile" in proof ? proof.testFile : undefined) ?? "contract-changes.test.ts";
    const source = join(scratch, proof.path), fixed = readFileSync(source, "utf8");
    assert.equal(run(proof.pattern, testFile).status, 0, `fixed: ${proof.rule}`);
    assert.ok(fixed.includes(proof.from), proof.rule);
    let reverted = fixed.replace(proof.from, proof.to);
    // A reverted function may need the raw reader that its shared presentation import replaced.
    if (proof.path !== "src/contract-changes.ts" && reverted.includes("readContractChange(") && !reverted.includes("import { readContractChange }")) {
      reverted = 'import { readContractChange } from "./contract-changes.ts";\n' + reverted;
    }
    if (proof.rule === "contract field isolation") reverted = reverted.replace("return `${title}${id}${metadata}${link}${preview}`;", "return `${merged}${id}${metadata}${link}${preview}`;");
    try {
      writeFileSync(source, reverted);
      if (proof.rebuild) build();
      const result = run(proof.pattern, testFile);
      assert.notEqual(result.status, 0, `revert must fail: ${proof.rule}`);
      assert.equal(result.signal, null, `revert must fail normally: ${proof.rule}`);
      assert.match(result.stdout + result.stderr, /ERR_ASSERTION|AssertionError|extension_item_field_unknown/, `behavioral failure: ${proof.rule}`);
    } finally {
      writeFileSync(source, fixed);
      if (proof.rebuild) build();
    }
    assert.equal(run(proof.pattern, testFile).status, 0, `restored: ${proof.rule}`);
    console.log(JSON.stringify({ rule: proof.rule, fixed_pass: 1, behavioral_revert_fail: 1, restored_pass: 1 }));
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
