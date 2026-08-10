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
import { equal, match, ok, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
      // Assert the LAYOUT runGate formats, not the reason wording, which pm-ops
      // owns: re-asserting the analyzer's strings here would re-couple this suite
      // to rules the header says live with the analyzer, and a pm-ops rewording
      // would break a launcher that had not changed.
      match(result.stderr, /sample\.ts:1\s+undocumented\s+-\s+\S/, "the violation names its file, line, symbol and a reason");
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
      // That it throws is the launcher's contract; the wording is pm-ops's.
      ok(thrown instanceof Error, "scanning zero files must throw, not report a clean scan");
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

    ok(isMainInvocation([process.execPath, gatePath], gateUrl), "a direct invocation runs the gate");
    ok(!isMainInvocation([process.execPath, resolve(packageRoot, "package.json")], gateUrl), "another entry point does not");
    ok(!isMainInvocation([process.execPath], gateUrl), "a missing argv[1] does not");
  });

  it("resolves a symlinked entry path to the real module URL", () => {
    // Without this case the direct-invocation assertion is tautological: argv[1]
    // and moduleUrl are built from the same path through the same transformation,
    // so it passes even with realpathSync removed - and realpathSync is the whole
    // reason the guard exists. npm bin shims and linked workspaces reach a script
    // through a symlink, and a gate that silently declines to run is worse than
    // one that throws.
    const gatePath = resolve(packageRoot, "scripts", "docstring-gate.ts");
    const linkDir = mkdtempSync(join(tmpdir(), "pm-changelog-docgate-link-"));
    const link = join(linkDir, "docstring-gate.ts");
    try {
      symlinkSync(gatePath, link);
      ok(
        isMainInvocation([process.execPath, link], pathToFileURL(gatePath).href),
        "a symlinked entry path resolves to the real module and runs the gate",
      );
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it("canonicalizes a symlinked moduleUrl, as --preserve-symlinks produces", () => {
    // The symlink test above passes argv[1] as the link and moduleUrl as the REAL
    // path, which the old one-sided comparison also satisfied - so it could not
    // tell the two implementations apart. This is the case that can: moduleUrl
    // holds the SYMLINK, which is what Node records in import.meta.url under
    // --preserve-symlinks / --preserve-symlinks-main.
    //
    // Old: pathToFileURL(realpathSync(link)).href === linkUrl -> false, so the
    // selector calls the placeholder and the gate exits 0 without scanning.
    // New: realpathSync(link) === realpathSync(fileURLToPath(linkUrl)) -> true.
    const gatePath = resolve(packageRoot, "scripts", "docstring-gate.ts");
    const linkDir = mkdtempSync(join(tmpdir(), "pm-changelog-docgate-preserve-"));
    const link = join(linkDir, "docstring-gate.ts");
    try {
      symlinkSync(gatePath, link);
      equal(
        isMainInvocation([process.execPath, link], pathToFileURL(link).href),
        true,
        "a symlinked moduleUrl must still resolve to a direct invocation",
      );
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it("throws rather than skipping the gate when argv[1] cannot be resolved", () => {
    const gateUrl = pathToFileURL(resolve(packageRoot, "scripts", "docstring-gate.ts")).href;
    // Returning false here would leave `npm run docstring` exiting 0 having
    // scanned nothing - a required release check reporting success without doing
    // its job. Crashing is the safe outcome, so assert it is what happens.
    throws(
      () => isMainInvocation([process.execPath, resolve(packageRoot, "does-not-exist.ts")], gateUrl),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
      "an unresolvable entry must propagate, not silently decline to run the gate",
    );
  });
});
