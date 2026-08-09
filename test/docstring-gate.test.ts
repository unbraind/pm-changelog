/**
 * Tests for this package's docstring gate launcher.
 *
 * The gate's RULES are not tested here. They live in the canonical analyzer
 * published as `pm-ops/docstrings`, together with a 62-case defeat-attempt suite
 * covering the ways a docstring can look present without being one — a JSDoc
 * block inside a string or template literal, one attached to a commented-out
 * declaration, one separated from its declaration by another statement, and one
 * that merely restates the identifier. Re-asserting those here would duplicate a
 * suite that already exists and would drift from it, which is precisely the
 * failure this package's vendored fork demonstrated: it ran inside
 * `release:check` and PASSED while the canonical analyzer found five
 * undocumented functions in this same source tree.
 *
 * What this file must prove is what the launcher itself adds: that it scans THIS
 * package by default, that a violation is reported actionably and exits non-zero,
 * that a clean scan exits zero, and that the entry-point guard does not silently
 * skip the gate.
 */

import { describe, it } from "node:test";
import { equal, match, ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

import { isMainInvocation, main, runGate } from "../scripts/docstring-gate.ts";

/** This package's own root, the default the CLI entry point scans. */
const packageRoot = resolve(import.meta.dirname, "..");

/**
 * Create a throwaway directory holding one TypeScript file.
 *
 * @param source - File contents to write as `sample.ts`.
 * @returns The directory path; the caller removes it.
 */
function fixtureRoot(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "pm-changelog-docgate-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "sample.ts"), source);
  return root;
}

describe("docstring gate launcher", () => {
  it("reports this package as fully documented", () => {
    const result = runGate(packageRoot);

    equal(result.exitCode, 0, "this package must satisfy the gate it ships");
    equal(result.stderr, "");
    match(result.stdout, /^docstring-gate: \d+ file\(s\), \d+ declaration\(s\) documented\.$/);
  });

  it("reports each violation with file, line and reason, and exits non-zero", () => {
    const root = fixtureRoot("export function undocumented(value: string): string {\n  return value;\n}\n");
    try {
      const result = runGate(root);

      equal(result.exitCode, 1);
      equal(result.stdout, "", "a failing run writes nothing to stdout");
      match(result.stderr, /1 violation\(s\)/);
      match(result.stderr, /sample\.ts:1\s+undocumented/, "the violation names its file, line and symbol");
      match(result.stderr, /no docstring/, "the violation names its reason");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes a root whose every declaration is documented", () => {
    const root = fixtureRoot(
      "/** Return the value unchanged, so the identity case has a named home. */\nexport function identity(value: string): string {\n  return value;\n}\n",
    );
    try {
      const result = runGate(root);

      equal(result.exitCode, 0);
      equal(result.stderr, "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws rather than passing vacuously when the root holds no TypeScript", () => {
    const root = mkdtempSync(join(tmpdir(), "pm-changelog-docgate-empty-"));
    try {
      let thrown: unknown;
      try {
        runGate(root);
      } catch (error) {
        thrown = error;
      }
      ok(thrown instanceof Error, "scanning zero files must throw, not report a clean scan");
      match(String(thrown), /no TypeScript source files|zero files/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("main with no arguments scans this package and leaves the exit code at zero", () => {
    const previousExitCode = process.exitCode;
    const written: string[] = [];
    const restore = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      main([]);
    } finally {
      process.stdout.write = restore;
      process.exitCode = previousExitCode;
    }

    equal(written.length, 1, "one stdout write, newline-terminated");
    match(written[0]!, /documented\.\n$/, "main appends the trailing newline runGate omits");
  });

  it("main with an explicit root writes the failure stream and sets a non-zero exit code", () => {
    const root = fixtureRoot("export function undocumented(value: string): string {\n  return value;\n}\n");
    const previousExitCode = process.exitCode;
    const written: string[] = [];
    const restore = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let observedExitCode: typeof process.exitCode;
    try {
      main([root]);
      observedExitCode = process.exitCode;
    } finally {
      process.stderr.write = restore;
      process.exitCode = previousExitCode;
      rmSync(root, { recursive: true, force: true });
    }

    equal(observedExitCode, 1, "a violating run sets process.exitCode rather than exiting");
    equal(written.length, 1);
    match(written[0]!, /1 violation\(s\)[\s\S]*\n$/);
  });

  it("recognizes a direct invocation and rejects a test import", () => {
    const gatePath = resolve(packageRoot, "scripts", "docstring-gate.ts");
    const gateUrl = pathToFileURL(gatePath).href;

    ok(isMainInvocation(["node", gatePath], gateUrl), "a direct invocation runs the gate");
    ok(!isMainInvocation(["node", resolve(packageRoot, "package.json")], gateUrl), "another entry point does not");
    ok(!isMainInvocation(["node"], gateUrl), "a missing argv[1] does not");
  });

  it("returns false rather than throwing when argv[1] cannot be resolved", () => {
    const gateUrl = pathToFileURL(resolve(packageRoot, "scripts", "docstring-gate.ts")).href;

    // A release gate that crashes on an unresolvable argv is worse than one that
    // declines to self-invoke: the guard must fail closed, not propagate ENOENT.
    ok(!isMainInvocation(["node", resolve(packageRoot, "does-not-exist.ts")], gateUrl));
  });
});
