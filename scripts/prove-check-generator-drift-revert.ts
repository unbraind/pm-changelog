/** Prove issue 339 regressions reject behavioral reverts in an owned disposable package. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProofRun } from "./proof-run.ts";
import { readProofBaseline } from "./proof-baseline.ts";
import { listAllComplete } from "@unbrained/pm-cli/sdk";

const scratch = mkdtempSync(join(tmpdir(), "pm-check-drift-revert-"));
try {
  for (const directory of ["src", "dist", "test", "docs", "scripts", ".github"]) cpSync(resolve(directory), join(scratch, directory), { recursive: true });
  for (const file of ["package.json", "manifest.json"]) cpSync(resolve(file), join(scratch, file));
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");
  const pmRoot = join(scratch, ".agents/pm");
  mkdirSync(join(pmRoot, "issues"), { recursive: true });
  mkdirSync(join(pmRoot, "history"));
  cpSync(resolve(".agents/pm/settings.json"), join(pmRoot, "settings.json"));
  for (const id of ["pmc-total-item-order", "pmc-contract-changes", "pmc-stable-itemless-check", "pmc-no-empty-unreleased-337"]) {
    for (const file of [`issues/${id}.toon`, `history/${id}.jsonl`]) cpSync(resolve(".agents/pm", file), join(pmRoot, file));
  }
  const extension = join(pmRoot, "extensions/pm-changelog");
  mkdirSync(extension, { recursive: true });
  cpSync(resolve("dist"), join(extension, "dist"), { recursive: true });
  cpSync(resolve("manifest.json"), join(extension, "manifest.json"));
  writeFileSync(join(extension, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(resolve("node_modules"), join(extension, "node_modules"), "junction");
  /** Run only the selected real-tracker assertions, preserving the production package. */
  const run = (pattern = ".*", testFile = "test/check-generator-drift.test.ts") => spawnSync(process.execPath, ["--test", "--test-concurrency=2", "--test-reporter=tap",
    `--test-name-pattern=${pattern}`, testFile], {
    cwd: scratch, encoding: "utf8", timeout: 1200000,
    env: { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PM_AUTHOR: "codex-changelog339-1111", PM_TELEMETRY_SOURCE_CONTEXT: "automation", DO_NOT_TRACK: "1" },
  });
  /** Require a real assertion failure rather than a syntax, setup or timeout error. */
  const fails = (pattern: string, count: number, testFile = "test/check-generator-drift.test.ts"): void => {
    const result = run(pattern, testFile);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`# fail ${count}\\b`));
    assert.match(result.stdout, /ERR_ASSERTION|AssertionError/);
  };
  // --baseline-only runs the fixed and restored controls without the mutation cases: default test runs check portability,
  // and the complete proof stays the registered pm test (timeout 1200 node scripts/prove-check-generator-drift-revert.ts).
  const proof = new ProofRun(process.argv.includes("--baseline-only") ? /^(fixed|restored)-controls$/ : undefined);
  const baseline = run();
  proof.run("fixed-controls", () => assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr));
  const passCount = Number(/# pass (\d+)/.exec(baseline.stdout)?.[1] ?? 0);
  const cli = join(scratch, "src/cli.ts"), fixedCli = readFileSync(cli, "utf8");
  const original = readProofBaseline(process.cwd());
  console.log(JSON.stringify({ baseline: original.kind }));
  /** Select only main, so every other fixed function remains in place. */
  const main = (source: string): string => {
    const start = source.indexOf("async function main(");
    assert.ok(start >= 0);
    return source.slice(start, source.indexOf("\n}", start) + 2);
  };
  proof.run("revert-main-diagnostics", () => {
    try {
      let previousMain = main(original.source);
      const start = previousMain.indexOf("    let driftMessage:");
      if (start !== -1) {
        const end = previousMain.indexOf("    if (options.githubOutput)", start);
        assert.ok(end > start);
        previousMain = previousMain.slice(0, start) + "    let driftMessage: string | undefined;\n\n" + previousMain.slice(end);
      }
      writeFileSync(cli, fixedCli.replace(main(fixedCli), previousMain));
      fails("^real non-git tracker:", 2);
      console.log(JSON.stringify({ mutation: "revert-main-diagnostics", reverted_fail: 2 }));
    } finally { writeFileSync(cli, fixedCli); }
  });
  proof.run("remove-failure-exit", () => {
    try {
      const from = "process.exitCode = 1;\n      return;";
      assert.ok(fixedCli.includes(from));
      writeFileSync(cli, fixedCli.replace(from, "process.exitCode = 0;\n      return;"));
      fails("^real non-git tracker:", 2);
      console.log(JSON.stringify({ mutation: "remove-failure-exit", reverted_fail: 2 }));
    } finally { writeFileSync(cli, fixedCli); }
  });
  const generator = join(scratch, "src/generator.ts"), fixedGenerator = readFileSync(generator, "utf8");
  proof.run("remove-previous-rendering-profile", () => {
    try {
      const from = "let next = !RENDERING_PROFILES[renderingVersion].modernMarkdown ? existing : omitEmptyUnreleasedSections(existing);";
      assert.ok(fixedGenerator.includes(from));
      writeFileSync(generator, fixedGenerator.replace(from, "let next = omitEmptyUnreleasedSections(existing);"));
      fails("^same real tracker:", 1);
      console.log(JSON.stringify({ mutation: "remove-previous-rendering-profile", reverted_fail: 1 }));
    } finally { writeFileSync(generator, fixedGenerator); }
  });
  proof.run("remove-previous-dependency-selection", () => {
    try {
      const from = "if (!RENDERING_PROFILES[renderingVersion].modernMarkdown) {";
      assert.ok(fixedGenerator.includes(from));
      writeFileSync(generator, fixedGenerator.replace(from, "if (false) {"));
      fails("^previous dependency selection", 1);
      console.log(JSON.stringify({ mutation: "remove-previous-dependency-selection", reverted_fail: 1 }));
    } finally { writeFileSync(generator, fixedGenerator); }
  });
  const driftFile = join(scratch, "src/check-drift.ts"), fixedDrift = readFileSync(driftFile, "utf8");
  for (const mutation of [
    { name: "host-argv-replay", from: "const argv = [...invocation, ...args];", to: "const argv = [...process.argv.slice(0, 2), ...args];", pattern: "^regeneration model" },
    { name: "stdin-input-loss", from: "if (options.stdin === true)", to: "if (false)", pattern: "^stdin regeneration" },
    { name: "posix-only-windows-command", from: 'const shell = platform === "win32" ? "powershell" : "posix";', to: 'const shell = "posix";', pattern: "^win32 regeneration" },
    { name: "unnormalized-host-options", from: 'const normalized = key.replace(/^--/, "").replace(/[-_]/g, "").toLowerCase();', to: "const normalized = key;", pattern: "^canonical host option registry" },
    { name: "same-version-upgrade-attribution", from: "revisions.previous !== revisions.current && committed === previous()", to: "committed === previous()", pattern: "^same-version reorder" },
    { name: "unproved-upgrade-attribution", from: "revisions.previous !== revisions.current && committed === previous()", to: "revisions.previous !== revisions.current", pattern: "^same-version reorder" },
    { name: "detached-multiline-details", from: `    while (index + 1 < lines.length) {
      let next = index + 1;
      while (next < lines.length && lines[next]!.trim() === "") next++;
      if (next === lines.length || !/^(?: {2,}|\\t)\\S/.test(lines[next]!)) break;
      block.push(...lines.slice(index + 1, next + 1));
      index = next;
    }`, to: '    while (index + 1 < lines.length && /^(?: {2,}|\\t)\\S/.test(lines[index + 1]!)) block.push(lines[++index]!);', pattern: "^blank-separated multiline" },
  ]) {
    proof.run(mutation.name, () => {
      try {
        assert.ok(fixedDrift.includes(mutation.from), mutation.name);
        writeFileSync(driftFile, fixedDrift.replace(mutation.from, mutation.to));
        fails(mutation.pattern, 1);
        console.log(JSON.stringify({ mutation: mutation.name, reverted_fail: 1 }));
      } finally { writeFileSync(driftFile, fixedDrift); }
    });
  }
  const facets = (await listAllComplete({}, { pmRoot })).items.find((item) => item.id === "pmc-total-item-order")!.change_facets;
  /** Write catalog mutations with the pinned CLI, retaining append-only history. */
  const setFacets = (value: unknown, id = "pmc-total-item-order"): void => {
    const result = spawnSync(resolve("node_modules/.bin/pm"), ["--path", pmRoot, "update", id, "--field", `change_facets=${JSON.stringify(value)}`], {
      cwd: scratch, encoding: "utf8", env: { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PM_AUTHOR: "codex-changelog339-1111", PM_TELEMETRY_SOURCE_CONTEXT: "automation", DO_NOT_TRACK: "1" },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  proof.run("remove-2026-11-7-upgrade-action", () => {
    try {
      setFacets([]);
      fails("^package tracker catalog", 1);
      console.log(JSON.stringify({ mutation: "remove-2026-11-7-upgrade-action", reverted_fail: 1 }));
    } finally { setFacets(facets); }
  });
  const catalog = (await listAllComplete({}, { pmRoot })).items;
  for (const id of ["pmc-contract-changes", "pmc-stable-itemless-check", "pmc-no-empty-unreleased-337"]) {
    const originalFacets = catalog.find((item) => item.id === id)!.change_facets;
    proof.run(`remove-catalog-action-${id}`, () => {
      try {
        setFacets([], id);
        fails("^every rendering-change item", 1);
        console.log(JSON.stringify({ mutation: `remove-catalog-action-${id}`, reverted_fail: 1 }));
      } finally { setFacets(originalFacets, id); }
    });
  }
  proof.run("remove-retained-ordering-comparator", () => {
    try {
      const from = "if (!RENDERING_PROFILES[renderingVersion].completionOrder) {";
      assert.ok(fixedGenerator.includes(from));
      writeFileSync(generator, fixedGenerator.replace(from, "if (false) {"));
      fails("^retained pre-2026", 1);
      console.log(JSON.stringify({ mutation: "remove-retained-ordering-comparator", reverted_fail: 1 }));
    } finally { writeFileSync(generator, fixedGenerator); }
  });
  proof.run("remove-historical-rendering-match", () => {
    try {
      const from = "committed === profile.render()";
      assert.ok(fixedDrift.includes(from));
      writeFileSync(driftFile, fixedDrift.replace(from, "false"));
      fails("^retained pre-2026", 1);
      console.log(JSON.stringify({ mutation: "remove-historical-rendering-match", reverted_fail: 1 }));
    } finally { writeFileSync(driftFile, fixedDrift); }
  });
  const upgrades = join(scratch, "src/consumer-upgrades.ts"), fixedUpgrades = readFileSync(upgrades, "utf8");
  proof.run("reject-unpublished-upgrade-declarations", () => {
    try {
      const from = '    if (getStringField(item, "release") === undefined && row.release === "Unreleased") continue;';
      assert.ok(fixedUpgrades.includes(from));
      writeFileSync(upgrades, fixedUpgrades.replace(from, ""));
      fails("^blank legacy releases", 1, "test/release-rendering-attribution.test.ts");
      console.log(JSON.stringify({ mutation: "reject-unpublished-upgrade-declarations", reverted_fail: 1 }));
    } finally { writeFileSync(upgrades, fixedUpgrades); }
  });
  const usage = join(scratch, "docs/usage.md"), fixedUsage = readFileSync(usage, "utf8");
  proof.run("unqualified-exit-code-documentation", () => {
    try {
      const from = "File-output checks (`--check` with `--output`, including its default";
      assert.ok(fixedUsage.includes(from));
      writeFileSync(usage, fixedUsage.replace(from, "Every difference exits 1; (including its default"));
      fails("^stdout checks", 1);
      console.log(JSON.stringify({ mutation: "unqualified-exit-code-documentation", reverted_fail: 1 }));
    } finally { writeFileSync(usage, fixedUsage); }
  });
  mkdirSync(join(scratch, "scripts"), { recursive: true });
  const baselineFile = join(scratch, "scripts/proof-baseline.ts");
  const fixedBaseline = readFileSync(resolve("scripts/proof-baseline.ts"), "utf8");
  proof.run("unconditional-git-baseline", () => {
    try {
      const from = 'return { source: readFileSync(join(cwd, "src/cli.ts"), "utf8"), kind: "working-tree" };';
      assert.ok(fixedBaseline.includes(from));
      writeFileSync(baselineFile, fixedBaseline.replace(from, 'throw new Error("A Git base is required");'));
      const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^proof baseline falls back", "test/proof-baseline.test.ts"], { cwd: scratch, encoding: "utf8", timeout: 120000 });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /ERR_ASSERTION|AssertionError/);
      assert.match(result.stdout, /# fail 1\b/);
      console.log(JSON.stringify({ mutation: "unconditional-git-baseline", reverted_fail: 1 }));
    } finally { writeFileSync(baselineFile, fixedBaseline); }
  });
  for (const mutation of [
    { name: "drop-historical-empty-sections", path: "src/generator.ts", from: "emptyUnreleased: true", to: "emptyUnreleased: false", all: true, pattern: "^published 2026", test: "test/check-generator-drift.test.ts" },
    { name: "oldest-rendering-first", path: "src/generator.ts", from: ".sort((a, b) => compareVersionStrings(b, a));", to: ".sort((a, b) => compareVersionStrings(a, b));", pattern: "^rendering history", test: "test/check-generator-drift.test.ts" },
    { name: "restore-ci-option-model", path: "src/cli.ts", from: '["explain", "explain"],', to: '["explain", "explain"], ["githubOutput", "github-output"], ["githubStepSummary", "github-step-summary"],', pattern: "^local regeneration omits CI", test: "test/check-generator-drift.test.ts" },
    { name: "restore-ci-guidance-flags", path: "src/check-drift.ts", from: ' || name === "github-output" || name === "github-step-summary"', to: "", pattern: "^local regeneration omits CI", test: "test/check-generator-drift.test.ts" },
    { name: "reject-blank-release", path: "src/consumer-upgrades.ts", from: 'getStringField(item, "release") === undefined', to: "item.release === undefined", pattern: "^blank legacy releases", test: "test/release-rendering-attribution.test.ts" },
    { name: "stop-proof-at-first-failure", path: "scripts/proof-run.ts", from: 'catch (error) { result =', to: 'catch (error) { throw error; result =', pattern: "^proof reports every", test: "test/proof-run.test.ts" },
    { name: "missing-source-derived-seam", path: "scripts/empty-unreleased-proof.ts", from: 'const matches = [...source.matchAll(definition.seam)];', to: 'const matches: RegExpMatchArray[] = [];', pattern: "^proof reports every", test: "test/proof-run.test.ts" },
    { name: "drop-release-attribution", path: "scripts/attribute-rendering-release.ts", from: 'await runUpdate(item.id, { release }, { path: pmRoot });', to: 'void release;', pattern: "^selected release attributes", test: "test/release-rendering-attribution.test.ts" },
    { name: "omit-release-tracker-staging", path: ".github/workflows/release.yml", from: "dist CHANGELOG.md .agents/pm", to: "dist CHANGELOG.md", pattern: "^selected release attributes", test: "test/release-rendering-attribution.test.ts" },
    { name: "skip-missing-release-boundary", path: "scripts/attribute-rendering-release.ts", from: 'if (eligible.length > 0 && !boundary)', to: 'if (false)', pattern: "^unproved release boundary refuses", test: "test/release-rendering-attribution.test.ts" },
    { name: "refuse-without-release-candidates", path: "scripts/attribute-rendering-release.ts", from: 'if (eligible.length > 0 && !boundary)', to: 'if (!boundary)', pattern: "^unproved release boundary succeeds", test: "test/release-rendering-attribution.test.ts" },
    { name: "trust-exact-version-404", path: "scripts/rendering-release-boundary.ts", from: 'if (response.status === 404) {', to: 'if (response.status === 404) return { state: "unpublished" };\n    if (false) {', pattern: "^registry publication proof", test: "test/release-rendering-attribution.test.ts" },
    { name: "accept-packument-without-time", path: "scripts/rendering-release-boundary.ts", from: 'headers: { Accept: "application/json" }', to: 'headers: { Accept: "application/vnd.npm.install-v1+json" }', pattern: "^registry publication proof", test: "test/release-rendering-attribution.test.ts" },
    { name: "empty-status-guidance", path: "src/cli.ts", from: 'options.statuses.length ? options.statuses.join(",") : ","', to: 'options.statuses.join(",")', pattern: "^empty and nonempty status lists", test: "test/check-generator-drift.test.ts" },
    { name: "noncanonical-publication-lookup", path: "scripts/rendering-release-boundary.ts", from: "encodeURIComponent(release)", to: "encodeURIComponent(version)", pattern: "^registry publication proof", test: "test/release-rendering-attribution.test.ts" },
    { name: "freeze-unpublished-draft-window", path: "scripts/rendering-release-boundary.ts", from: 'if (publication.state === "unpublished") commit = base;', to: 'if (publication.state === "unpublished") commit = commitId(cwd, `${base}~1`);', pattern: "^selected release attributes", test: "test/release-rendering-attribution.test.ts" },
    { name: "authorize-unknown-publication", path: "scripts/rendering-release-boundary.ts", from: 'if (publication.state === "unknown") return refuse("publication_state_unknown");', to: 'if (publication.state === "unknown") publication = { state: "unpublished" };', pattern: "^unproved release boundary", test: "test/release-rendering-attribution.test.ts" },
    { name: "first-version-instead-of-publication", path: "scripts/rendering-release-boundary.ts", from: 'if (!commit) return refuse("published_commit_unavailable");', to: 'commit = git(cwd, ["rev-list", "--first-parent", "--reverse", base, "--", "package.json"])?.trim().split("\\n").find((candidate) => packageVersion(cwd, candidate) === version);\n    if (!commit) return refuse("published_commit_unavailable");', pattern: "^publication gitHead after", test: "test/rendering-release-boundary.test.ts" },
    { name: "published-recovery-uses-current-base", path: "scripts/rendering-release-boundary.ts", from: 'if (!commit) return refuse("published_commit_unavailable");', to: 'commit = base;\n    if (!commit) return refuse("published_commit_unavailable");', pattern: "^published recovery never advances", test: "test/rendering-release-boundary.test.ts" },
    { name: "tag-overrides-supplied-githead", path: "scripts/rendering-release-boundary.ts", from: 'if (publication.gitHead !== undefined) commit = commitId(cwd, publication.gitHead);', to: 'if (false) commit = commitId(cwd, publication.gitHead);', pattern: "^publication gitHead after", test: "test/rendering-release-boundary.test.ts" },
    { name: "plural-exclude-tag-alias-dropped", path: "src/check-drift.ts", from: 'Object.freeze({ excludetags: "excludetag" })', to: 'Object.freeze({})', pattern: "^regeneration options keep the plural", test: "test/release-boundary-round9.test.ts" },
    { name: "unprefixed-tag-ignored", path: "scripts/rendering-release-boundary.ts", from: 'commit = prefixed ?? plain;', to: 'commit = prefixed;', pattern: "^without gitHead an unprefixed", test: "test/release-boundary-round9.test.ts" },
    { name: "disagreeing-tags-accepted", path: "scripts/rendering-release-boundary.ts", from: 'if (prefixed && plain && prefixed !== plain) return refuse("published_tag_ambiguous");', to: '', pattern: "^without gitHead an unprefixed", test: "test/release-boundary-round9.test.ts" },
    { name: "sub-second-release-boundary", path: "scripts/attribute-rendering-release.ts", from: 'time >= boundary.timestamp + 1000', to: 'time >= boundary.timestamp', pattern: "^a completion inside the release commit", test: "test/release-boundary-round9.test.ts" },
    { name: "edited-source-backed-reason", path: "scripts/attribute-rendering-release.ts", from: ' || (sourcesCloseReason(frozen) && item.close_reason !== frozen.close_reason)', to: '', pattern: "^a source-backed close reason", test: "test/release-boundary-round9.test.ts" },
    { name: "published-boundary-ignores-main", path: "scripts/rendering-release-boundary.ts", from: 'if (!main || git(cwd, ["merge-base", "--is-ancestor", commit, main]) === undefined)', to: 'if (false)', pattern: "^published objects must match", test: "test/rendering-release-boundary.test.ts" },
    { name: "ignore-frozen-non-change", path: "scripts/attribute-rendering-release.ts", from: ' || isNonChangeClosure(frozen, context)', to: '', pattern: "^frozen delivery facts", test: "test/release-rendering-attribution.test.ts" },
    { name: "ignore-frozen-completion", path: "scripts/attribute-rendering-release.ts", from: ' || time !== Date.parse(original.timestamp)', to: '', pattern: "^frozen delivery facts", test: "test/release-rendering-attribution.test.ts" },
    { name: "ignore-frozen-facets", path: "scripts/attribute-rendering-release.ts", from: '|| !isDeepStrictEqual(item.change_facets, frozen.change_facets)', to: '', pattern: "^frozen delivery facts", test: "test/release-rendering-attribution.test.ts" },
    { name: "posix-only-copied-command-assertion", path: "test/check-generator-drift.test.ts", from: 'assert.equal(command, regenerationCommand({}, argv, shell === "powershell" ? "win32" : "linux").command);', to: 'assert.match(command, /^pm --path /);', pattern: "^copied-command fixtures", test: "test/check-generator-drift.test.ts" },
    { name: "copied-command-uses-default-shell", path: "test/check-generator-drift.test.ts", from: 'return shell === "powershell"', to: 'return false', pattern: "^copied-command fixtures", test: "test/check-generator-drift.test.ts" },
    { name: "document-helper-as-receipt", path: "docs/usage.md", from: 'including entry-only reorders without that evidence, are `tracker_changed`.', to: 'The file receipt can report `reorder_only`.', pattern: "^stdout checks", test: "test/check-generator-drift.test.ts" },
    { name: "drop-release-decision-base", path: ".github/workflows/release.yml", from: ' "${RELEASE_BASE_SHA}"', to: '', pattern: "^selected release attributes", test: "test/release-rendering-attribution.test.ts" },
    { name: "new-format-in-old-profiles", path: "src/generator.ts", from: 'contractFormatting: false', to: 'contractFormatting: true', all: true, pattern: "^published legacy contract", test: "test/check-generator-drift.test.ts" },
    { name: "assert-cli-committed-version", path: "src/cli.ts", from: 'matches rendering profile ${diagnosis.comparedVersion}', to: 'committed rendering ${diagnosis.comparedVersion}', pattern: "^published 2026", test: "test/check-generator-drift.test.ts" },
    { name: "assert-extension-committed-version", path: "src/extension.ts", from: 'matches rendering profile ${drift.comparedVersion}', to: 'committed rendering ${drift.comparedVersion}', pattern: "^retained pre-2026", test: "test/check-generator-drift.test.ts" },
    { name: "consumer-tracker-instructions", path: "docs/consumer-upgrades.md", from: "run this query from its root", to: "run this query from a consumer root", pattern: "^package catalog documentation", test: "test/check-generator-drift.test.ts" },
  ]) {
    proof.run(mutation.name, () => {
      const path = join(scratch, mutation.path), fixed = readFileSync(path, "utf8");
      assert.ok(fixed.includes(mutation.from), mutation.name);
      try {
        writeFileSync(path, mutation.all ? fixed.replaceAll(mutation.from, mutation.to) : fixed.replace(mutation.from, mutation.to));
        fails(mutation.pattern, 1, mutation.test);
        console.log(JSON.stringify({ mutation: mutation.name, reverted_fail: 1 }));
      } finally { writeFileSync(path, fixed); }
    });
  }
  proof.run("remove-published-prepend-delivery", () => {
    const id = "pmc-no-empty-unreleased-337";
    const release = String(catalog.find((item) => item.id === id)!.release);
    /** Keep publication metadata mutations in native append-only history. */
    function setRelease(value: string | undefined): void {
      const result = spawnSync(resolve("node_modules/.bin/pm"), ["--path", pmRoot, "update", id, ...(value ? ["--release", value] : ["--unset", "release"])], {
        cwd: scratch, encoding: "utf8", env: { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PM_AUTHOR: "codex-changelog339-1111", PM_TELEMETRY_SOURCE_CONTEXT: "automation", DO_NOT_TRACK: "1" },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    try {
      setRelease(undefined);
      fails("^package published prepend cleanup", 1);
      console.log(JSON.stringify({ mutation: "remove-published-prepend-delivery", reverted_fail: 1 }));
    } finally { setRelease(release); }
  });
  proof.run("revert-published-recovery-boundary", () => {
    const path = join(scratch, "scripts/attribute-rendering-release.ts"), fixed = readFileSync(path, "utf8");
    const seam = /    if \(!boundary[\s\S]*?\n    }\n/.exec(fixed)?.[0];
    assert.ok(seam, "Missing attribution boundary guard");
    try {
      writeFileSync(path, fixed.replace(seam, ""));
      fails("^published recovery", 1, "test/release-rendering-attribution.test.ts");
      console.log(JSON.stringify({ mutation: "revert-published-recovery-boundary", reverted_fail: 1 }));
    } finally { writeFileSync(path, fixed); }
  });
  for (const name of ["formatItem", "resolveEntryTitle", "groupByCategory", "groupByField", "collectBreakingItems"]) {
    proof.run(`restore-current-contract-${name}`, () => {
      const start = fixedGenerator.indexOf(`function ${name}(`);
      assert.ok(start >= 0, name);
      const end = fixedGenerator.indexOf("\n}", start) + 2;
      const fixed = fixedGenerator.slice(start, end);
      const reverted = fixed.replace("RENDERING_PROFILES[renderingVersion].contractFormatting && ", "")
        .replace("RENDERING_PROFILES[renderingVersion].contractFormatting ? readContractChange(item) : undefined", "readContractChange(item)")
        .replace("(!RENDERING_PROFILES[renderingVersion].contractFormatting || !readContractChange(item))", "!readContractChange(item)");
      assert.notEqual(reverted, fixed, name);
      try {
        writeFileSync(generator, fixedGenerator.replace(fixed, reverted));
        fails("^published legacy contract", 1);
        console.log(JSON.stringify({ mutation: `restore-current-contract-${name}`, reverted_fail: 1 }));
      } finally { writeFileSync(generator, fixedGenerator); }
    });
  }
  proof.run("restored-controls", () => {
    const restored = run();
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, new RegExp(`# pass ${passCount}\\b`));
    console.log(JSON.stringify({ fixed_pass: passCount, restored_pass: passCount }));
  });
  proof.finish();
} finally { rmSync(scratch, { recursive: true, force: true }); }
