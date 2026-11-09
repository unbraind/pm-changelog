/** Adversarial projection parity, including historical nulls and packed consumers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { decode, encode } from "@toon-format/toon";
import { auditChangelogClaims, buildChangelogDocument, createChangelog, createChangelogSummary, formatClaimAudit, formatSummaryLine } from "../src/index.ts";
import type { PmItem } from "../src/index.ts";

const declaration = { before: "Allowed", after: "Refused", migrate: "Handle the refusal" };
const base: PmItem = { id: "fixture-projection", title: "Contract", type: "Task", status: "closed", close_reason: "Delivered PR #12" };

/** Compare all consuming projections, not a second implementation of the reader. */
function projections(item: PmItem) {
  const options = { items: [item], date: "2026-11-06" };
  const report = auditChangelogClaims(options);
  return { markdown: createChangelog(options).markdown, document: buildChangelogDocument(options), summary: createChangelogSummary(options),
    auditJson: JSON.parse(formatClaimAudit(report, "json")), auditToon: decode(formatClaimAudit(report, "toon")) };
}

test("contract projection: nullish precedence preserves every historical absence and malformed value", () => {
  const alternatives = [undefined, null, false, 0, "", "legacy", [], {}, declaration, { ...declaration, migrate: " " }];
  // Source selection is declared independently for each direct-value class.
  for (const mode of [{ direct: undefined, fallback: true }, { direct: null, fallback: true },
    ...[false, 0, "", "legacy", [], {}, declaration].map((direct) => ({ direct, fallback: false }))]) {
    const direct = mode.direct;
    for (const nested of alternatives) {
      const selected = mode.fallback && nested !== undefined ? nested : direct;
      const mixed = JSON.parse(JSON.stringify({ ...base, contract_change: direct, metadata: { contract_change: nested } })) as PmItem;
      const canonical = JSON.parse(JSON.stringify({ ...base, contract_change: selected })) as PmItem;
      const original = JSON.stringify(mixed);
      for (const item of [mixed, decode(encode(mixed)) as unknown as PmItem]) {
        assert.deepEqual(projections(item), projections(canonical));
      }
      assert.equal(JSON.stringify(mixed), original);
    }
  }
});

test("contract projection: every presentation path shares single-line title and entry-source policy", () => {
  let seed = 0x328;
  const separators = ["\n", "\r\n", "\r", "\t", "\u2028", "\u2029", "  "];
  for (let index = 0; index < 100; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const title = `  Declared${separators[seed % separators.length]}behavior${separators[(seed >>> 8) % separators.length]}changed  `;
    for (const entryFrom of ["title", "close_reason"] as const) {
      for (const sectionBy of ["category", "type", "status", "label"] as const) {
        const options = { items: [{ ...base, title, contract_change: declaration }], entryFrom, sectionBy };
        const entries = createChangelogSummary(options);
        assert.equal(entries[0].title, "Declared behavior changed");
        assert.equal(buildChangelogDocument(options).releases[0].sections[0].items[0].title, "Declared behavior changed");
        assert.doesNotMatch(formatSummaryLine(entries[0]), /[\r\n\u2028\u2029]/);
        assert.match(createChangelog(options).markdown, /- Declared behavior changed: Allowed → Refused\. Migrate: Handle the refusal/);
      }
    }
  }
});

test("contract projection: summary projection bounds declared fields to one line", () => {
  for (const separator of ["\n", "\r\n", "\r", "\u2028", "\u2029", "\t"]) {
    for (const id of [undefined, `fixture${separator}id`]) for (const version of [undefined, `one${separator}two`]) {
      const entries = createChangelogSummary({ version, items: [{ ...base, id, title: `Before${separator}after`, contract_change: declaration }] });
      const line = formatSummaryLine(entries[0]);
      assert.doesNotMatch(line, /[\r\n\u2028\u2029\t]/);
      assert.ok(line.endsWith(`Changed (SDK contract): Before after${id ? " (fixture id)" : ""}`));
    }
  }
});

test("contract projection: undeclared summary formatter preserves legacy caller fields", () => {
  for (const separator of ["\n", "\r\n", "\r", "\u2028", "\u2029", "\t", "  "]) {
    for (const version of [undefined, `one${separator}two`]) {
      for (const category of [`Fixed${separator}items`, "Changed (SDK contract)"]) {
        const line = formatSummaryLine({ heading: `one${separator}two`, version, category, title: `  Before${separator}after  `, id: `fixture${separator}id` });
        assert.equal(line, `[one${separator}two] ${category}:   Before${separator}after   (fixture${separator}id)`);
      }
    }
  }
});

test("packed contract projections agree in Node and available Bun SDK, CLI and host without git", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-contract-packed-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const home = join(cwd, "home"); mkdirSync(home);
  const childEnv = { PATH: process.env.PATH, HOME: home, NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", DO_NOT_TRACK: "1", GIT_CEILING_DIRECTORIES: tmpdir() };
  /** Run real package tools without inherited credentials and surface assertion failures. */
  const run = (binary: string, args: string[], directory: string) => {
    const result = spawnSync(binary, args, { cwd: directory, env: childEnv, encoding: "utf8", timeout: 120000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", cwd], resolve("."))) as { filename: string }[];
  const consumer = join(cwd, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "contract-consumer", private: true, type: "module", dependencies: { "@toon-format/toon": `file:${resolve("node_modules/@toon-format/toon")}` } }));
  run("npm", ["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", join(cwd, packed[0].filename)], consumer);
  mkdirSync(join(consumer, "node_modules/@unbrained"), { recursive: true });
  symlinkSync(resolve("node_modules/@unbrained/pm-cli"), join(consumer, "node_modules/@unbrained/pm-cli"), "junction");
  cpSync(resolve("test/fixtures/contract-projection-consumer.ts"), join(consumer, "probe.ts"));
  const bunVersion = spawnSync("bun", ["--version"], { env: childEnv, encoding: "utf8" });
  const bunMissing = bunVersion.error !== undefined && "code" in bunVersion.error && bunVersion.error.code === "ENOENT";
  const runtimes = bunMissing ? [process.execPath] : [process.execPath, "bun"];
  for (const runtime of runtimes) {
    const output = run(runtime, ["probe.ts", join(cwd, runtime === "bun" ? "bun-tracker" : "node-tracker")], consumer);
    assert.match(output, /packed projections passed/);
  }
});

test("packed contract projections run without Bun installed", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-contract-node-only-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const bin = join(cwd, "bin"), home = join(cwd, "home");
  mkdirSync(bin); mkdirSync(home);
  const npm = (process.env.PATH ?? "").split(delimiter).map((path) => join(path, "npm")).find(existsSync);
  assert.ok(npm, "npm is required by the documented Node setup");
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(npm, join(bin, "npm"));
  // npm spawns lifecycle and exec commands through sh, so the Bun-free PATH still needs a POSIX shell.
  const sh = [...(process.env.PATH ?? "").split(delimiter), "/bin", "/usr/bin"].map((path) => join(path, "sh")).find(existsSync);
  if (process.platform !== "win32") { assert.ok(sh, "a POSIX shell is required for npm"); symlinkSync(sh!, join(bin, "sh")); }
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=2", "--test-name-pattern=^packed contract projections agree", "test/contract-projections.test.ts"], {
    cwd: resolve("."), encoding: "utf8", timeout: 120000,
    env: { PATH: bin, HOME: home, NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", DO_NOT_TRACK: "1" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /pass 1/);
});
