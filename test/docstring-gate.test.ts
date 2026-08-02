/**
 * Behavioural tests for the docstring coverage gate.
 *
 * Every case runs the real script against a throwaway workspace, because the
 * properties worth protecting are exactly the ones a unit test of an internal
 * helper would miss: that the gate reads the directory it was pointed at, that
 * it refuses to pass when it found nothing, and that a declaration hidden in a
 * string or a comment is not mistaken for real code.
 */
import { describe, it } from "node:test";
import { equal, match, ok } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/** Absolute path to the gate under test. */
const GATE = join(import.meta.dirname, "..", "scripts", "docstring-gate.ts");

/** Outcome of one gate run against a fixture workspace. */
interface GateRun {
  /** Combined stdout, which carries the success line. */
  readonly stdout: string;
  /** Combined stderr, which carries the violation report. */
  readonly stderr: string;
  /** Process exit code: 0 on a complete documented surface, 1 otherwise. */
  readonly status: number;
}

/**
 * Run the gate over a temporary workspace built from `files`.
 *
 * Paths are relative to the workspace root, so a case can place sources under
 * `src/`, under `scripts/`, or nowhere at all. The workspace is removed even
 * when the assertion that follows fails.
 */
function runGate(files: Record<string, string>, roots: string[] = []): GateRun {
  const dir = mkdtempSync(join(tmpdir(), "docstring-gate-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    try {
      const stdout = execFileSync(process.execPath, [GATE, ...roots], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { stdout, stderr: "", status: 0 };
    } catch (error: unknown) {
      const spawned = error as { status?: number; stdout?: string; stderr?: string };
      return {
        stdout: spawned.stdout ?? "",
        stderr: spawned.stderr ?? "",
        status: spawned.status ?? 1,
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A docstring that carries real information about a `parseConfig` function. */
const GOOD_DOC = "/** Load and validate the YAML settings file from disk. */\n";

describe("docstring-gate: what counts as documented", () => {
  it("passes an exported function carrying an informative docstring", () => {
    const run = runGate({ "src/a.ts": `${GOOD_DOC}export function parseConfig(): void {}` });
    equal(run.status, 0, run.stderr);
    match(run.stdout, /documented surface complete/);
  });

  it("fails an exported function with no docstring, naming file, line and symbol", () => {
    const run = runGate({ "src/a.ts": "export function parseConfig(): void {}" });
    equal(run.status, 1);
    match(run.stderr, /src\/a\.ts:1\s+parseConfig - no docstring/);
  });

  it("rejects a docstring that only restates the identifier", () => {
    // Long enough to clear the word-count floor, so this exercises the
    // name-echo check rather than the length check.
    const run = runGate({
      "src/a.ts":
        "/** Parse the workspace config file. */\nexport function parseWorkspaceConfigFile(): void {}",
    });
    equal(run.status, 1);
    match(run.stderr, /restates the identifier/);
  });

  it("rejects a docstring too short to say anything", () => {
    const run = runGate({ "src/a.ts": "/** Reads it. */\nexport const TIMEOUT = 5;" });
    equal(run.status, 1);
    match(run.stderr, /under 4 meaningful words/);
  });

  it("requires a docstring on every exported declaration kind", () => {
    const run = runGate({
      "src/a.ts": [
        "export interface Config { name: string }",
        "export type Json = string | number;",
        "export const API_URL = 'https://example.com';",
        "export class Loader {}",
        "export enum Mode { On }",
      ].join("\n"),
    });
    equal(run.status, 1);
    for (const symbol of ["Config", "Json", "API_URL", "Loader", "Mode"]) {
      match(run.stderr, new RegExp(`${symbol} - no docstring`));
    }
  });
});

describe("docstring-gate: defeat attempts", () => {
  it("does not accept a JSDoc that only exists inside a string literal", () => {
    const run = runGate({
      "src/a.ts": "export const MSG = '/** Load and validate settings from disk. */';",
    });
    equal(run.status, 1);
    match(run.stderr, /MSG - no docstring/);
  });

  it("does not accept a JSDoc attached to a commented-out declaration", () => {
    const run = runGate({
      "src/a.ts": [
        "// /** Load and validate settings from disk. */",
        "// export function deadCode(): void {}",
        "export function liveCode(): void {}",
      ].join("\n"),
    });
    equal(run.status, 1);
    match(run.stderr, /liveCode - no docstring/);
    ok(!run.stderr.includes("deadCode"), "a commented-out declaration is not a declaration");
  });

  it("does not let a line comment or a bare block comment stand in for JSDoc", () => {
    const run = runGate({
      "src/a.ts": [
        "// Load and validate the settings file from disk.",
        "export function parseConfig(): void {}",
        "/* Load and validate the settings file from disk. */",
        "export function readConfig(): void {}",
      ].join("\n"),
    });
    equal(run.status, 1);
    match(run.stderr, /parseConfig - no docstring/);
    match(run.stderr, /readConfig - no docstring/);
  });

  it("does not let an unrelated banner comment document the declaration below it", () => {
    const run = runGate({
      "src/a.ts": [
        "/** Shared helpers for reading workspace settings from disk. */",
        "",
        "// section divider",
        "export function parseConfig(): void {}",
      ].join("\n"),
    });
    equal(run.status, 1);
    match(run.stderr, /parseConfig - no docstring/);
  });

  it("discovers files added after the fact, including in nested directories", () => {
    const run = runGate({
      "src/a.ts": `${GOOD_DOC}export function parseConfig(): void {}`,
      "src/nested/deep/b.ts": "export function hidden(): void {}",
    });
    equal(run.status, 1);
    match(run.stderr, /nested\/deep\/b\.ts/);
  });

  it("refuses to pass vacuously when no source file exists", () => {
    const run = runGate({ "README.md": "# nothing to scan" });
    equal(run.status, 1);
    match(run.stderr, /refusing to pass vacuously/);
  });

  it("refuses a requested root that does not exist", () => {
    const run = runGate({ "src/a.ts": `${GOOD_DOC}export function parseConfig(): void {}` }, ["nope"]);
    equal(run.status, 1);
    match(run.stderr, /root\(s\) not found: nope/);
  });
});

describe("docstring-gate: parsing real TypeScript", () => {
  it("survives template literals and regular expressions", () => {
    // A hand-driven lexer stalls on the `#` inside this template and mis-lexes
    // the regex as division; a real parse handles both.
    const run = runGate({
      "src/a.ts": [
        "const heading = (t: string): string => `# ${t} - ${t}`;",
        "const RELEASE = /^##\\s+(.+)$/gm;",
        "export function parseConfig(): void { void heading; void RELEASE; }",
      ].join("\n"),
    });
    equal(run.status, 1);
    match(run.stderr, /parseConfig - no docstring/);
  });

  it("checks non-private members of an exported class, and skips private ones", () => {
    const run = runGate({
      "src/a.ts": [
        "/** Reads workspace settings and caches parsed results. */",
        "export class Loader {",
        "  private cache = new Map<string, string>();",
        "  #secret = 1;",
        "  protected hidden(): void {}",
        "  constructor() {}",
        "  load(): void {}",
        "  get size(): number { return 0; }",
        "}",
      ].join("\n"),
    });
    equal(run.status, 1);
    for (const symbol of ["Loader.constructor", "Loader.load", "Loader.size"]) {
      match(run.stderr, new RegExp(`${symbol.replace(".", "\\.")} - no docstring`));
    }
    for (const skipped of ["cache", "secret", "hidden"]) {
      ok(!run.stderr.includes(skipped), `${skipped} is outside the documented surface`);
    }
  });

  it("holds a long internal function to the rule but leaves a short one alone", () => {
    const run = runGate({
      "src/a.ts": [
        "function tiny(): number { return 1; }",
        "function long(): number {",
        "  const a = 1;",
        "  const b = 2;",
        "  const c = 3;",
        "  const d = 4;",
        "  const e = 5;",
        "  return a + b + c + d + e;",
        "}",
        `${GOOD_DOC}export function parseConfig(): number { return tiny() + long(); }`,
      ].join("\n"),
    });
    equal(run.status, 1);
    match(run.stderr, /long - no docstring/);
    ok(!run.stderr.includes("tiny"), "a short internal helper needs no docstring");
  });

  it("documents an overload set once, on the implementation", () => {
    const run = runGate({
      "src/a.ts": [
        "/** Reads workspace settings and caches parsed results. */",
        "export class Loader {",
        "  /** Fetch one stored entry, or every entry when no key is given. */",
        "  load(key: string): string;",
        "  load(): string[];",
        "  load(key?: string): string | string[] { return key ?? []; }",
        "}",
      ].join("\n"),
    });
    equal(run.status, 0, run.stderr);
  });

  it("does not demand a docstring on a re-export or a destructured binding", () => {
    const run = runGate({
      "src/dep.ts": `${GOOD_DOC}export function parseConfig(): void {}`,
      "src/a.ts": [
        "import { parseConfig } from './dep.ts';",
        "export { parseConfig };",
        "export * from './dep.ts';",
        "const pair = { left: 1, right: 2 };",
        "export const { left, right } = pair;",
      ].join("\n"),
    });
    equal(run.status, 0, run.stderr);
  });

  it("scans the scripts root as well as src", () => {
    const run = runGate({
      "src/a.ts": `${GOOD_DOC}export function parseConfig(): void {}`,
      "scripts/tool.ts": "export function undocumentedTool(): void {}",
    });
    equal(run.status, 1);
    match(run.stderr, /scripts\/tool\.ts/);
  });

  it("scans only the roots it was asked for", () => {
    const run = runGate(
      {
        "src/a.ts": `${GOOD_DOC}export function parseConfig(): void {}`,
        "scripts/tool.ts": "export function undocumentedTool(): void {}",
      },
      ["src"],
    );
    equal(run.status, 0, run.stderr);
  });
});
