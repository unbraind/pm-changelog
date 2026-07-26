import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import type { ExtensionActivationResult, ExtensionCapability, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";

import extension from "../dist/extension.js";

/**
 * Capabilities the on-disk `manifest.json` declares.
 *
 * Read from the manifest so activation runs under the exact grant the published
 * package ships with: a surface registered without a matching declared
 * capability fails here the same way it fails in the CLI, rather than passing
 * against a permissive stub.
 */
const parsedManifest: unknown = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "manifest.json"), "utf-8"),
);
assert.ok(
  parsedManifest !== null && typeof parsedManifest === "object",
  "manifest.json must parse to an object",
);
const declaredCapabilities = (parsedManifest as { capabilities?: unknown }).capabilities;
assert.ok(
  Array.isArray(declaredCapabilities) && declaredCapabilities.every((entry) => typeof entry === "string"),
  "manifest.json must declare capabilities as an array of strings",
);
const MANIFEST_CAPABILITIES = declaredCapabilities as readonly ExtensionCapability[];

let cachedActivation: Promise<ExtensionActivationResult> | undefined;

/**
 * Activate pm-changelog through pm's real extension loader, once per test process.
 *
 * Activation is deterministic and side-effect free, so the result is memoized
 * and shared. Asserting `failed` here means a broken activation surfaces as a
 * clear failure rather than as empty registration lists downstream.
 */
function activateChangelog(): Promise<ExtensionActivationResult> {
  cachedActivation ??= (async () => {
    const activation = await activateExtensionForTest(extension, {
      name: "pm-changelog",
      capabilities: MANIFEST_CAPABILITIES,
    });
    assert.deepEqual(activation.failed, [], "extension activation must not fail");
    return activation;
  })();
  return cachedActivation;
}

/** Long-form flag names registered against one command path. */
async function registeredFlagLongs(command: string): Promise<(string | undefined)[]> {
  const entry = (await activateChangelog()).registrations.flags.find(
    (candidate) => candidate.target_command === command,
  );
  assert.ok(entry, `flags should be registered for "${command}"`);
  return entry.flags.map((flag: FlagDefinition) => flag.long);
}

test("extension command exposes item-url-base for clickable item IDs", async () => {
  const activation = await activateChangelog();

  // `registerExporter` registers its handler under the "<name> export" command
  // path, so the exporter's flags and examples surface through the same command
  // registries the host dispatches on — which is what the CLI actually reads.
  const exporterCommand = activation.registrations.commands.find(
    (entry) => entry.command === "changelog export",
  );
  assert.ok(exporterCommand, "extension should register the changelog exporter");
  const exportFlags = await registeredFlagLongs("changelog export");
  assert.ok(exportFlags.includes("--format"), "changelog export should expose --format through pm contracts");
  assert.ok(
    exportFlags.includes("--release-notes"),
    "changelog export should expose release-notes mode through pm contracts",
  );
  assert.ok(
    exporterCommand.examples?.some((example) => example.includes("changelog export --format json")),
    "changelog export should document json export usage",
  );

  assert.ok(
    activation.registrations.commands.some((entry) => entry.command === "changelog generate"),
    "extension should register the changelog command",
  );
  const generateFlags = await registeredFlagLongs("changelog generate");
  for (const flag of [
    "--item-url-base",
    "--release-version-from-package",
    "--since-previous-tag",
    "--until-release-tag",
    "--all-release-tags",
    "--release-tag-pattern",
    "--section-by",
    "--conventional",
    "--contributors",
    "--limit",
    "--since-version",
    "--include-metadata",
    "--changelog-json",
    "--explain",
    "--summary",
    "--format",
    "--item-ref-style",
    "--exclude-tag",
    "--respect-item-release",
  ]) {
    assert.ok(
      generateFlags.includes(flag),
      `changelog generate should expose ${flag} through pm contracts`,
    );
  }

  // Both subcommands must carry the release-attribution surface: release notes
  // are generated through the exporter, so an exporter missing the flags would
  // silently misattribute closed-late trackers.
  for (const flag of ["--item-ref-style", "--exclude-tag", "--respect-item-release"]) {
    assert.ok(
      exportFlags.includes(flag),
      `changelog export should expose ${flag} through pm contracts`,
    );
  }

  const rendererOwnership = activation.renderers.overrides;
  assert.deepEqual(
    rendererOwnership.map((override) => ({ format: override.format, commands: override.commands })),
    [
      { format: "toon", commands: ["changelog generate", "changelog export"] },
      { format: "json", commands: ["changelog generate", "changelog export"] },
    ],
  );
  for (const override of rendererOwnership) {
    assert.equal(
      override.resultDiscriminator?.({ pmChangelogRendered: true, output: "{}\n" }),
      true,
    );
    assert.equal(override.resultDiscriminator?.({ output: "{}\n" }), false);
  }
});

test("changelog exporter rejects unsupported formats", async () => {
  const { commands } = await activateChangelog();
  await assert.rejects(
    () => runRegisteredCommandForTest(commands, {
      command: "changelog export",
      options: { format: "js" },
      pmRoot: process.cwd(),
    }),
    /--format must be 'md' or 'json'/,
  );
});

test("changelog generate rejects unsupported formats before workspace reads", async () => {
  const { commands } = await activateChangelog();
  await assert.rejects(
    () => runRegisteredCommandForTest(commands, {
      command: "changelog generate",
      options: { format: "jsn" },
      pmRoot: "/path/that/does/not/exist",
    }),
    /--format must be 'md' or 'json'/,
  );
});

// This is the one test that must keep a hand-built `api` double rather than use
// `activateExtensionForTest`. Its subject is the compatibility branch taken when
// the *host* is an older pm-cli whose `registerExporter` accepts only
// (name, handler) and therefore cannot carry flags — the extension then falls
// back to `registerFlags`. The harness always activates against the current
// host, so it cannot express "pretend registerExporter has arity 2"; a stub is
// the only way to simulate a different runtime version.
test("changelog exporter registers flags on legacy two-argument pm-cli runtimes", () => {
  let registeredFlags: Array<{ long?: string }> | undefined;
  const registerExporter = function (_name: string, _handler: unknown) {};
  extension.activate({
    registerCommand() {},
    registerExporter,
    registerFlags(_command: string, flags: Array<{ long?: string }>) {
      registeredFlags = flags;
    },
  } as unknown as Parameters<typeof extension.activate>[0]);

  assert.ok(
    registeredFlags?.some((flag) => flag.long === "--format"),
    "legacy pm-cli runtimes should still surface changelog export flags"
  );
});

test("changelog generate surfaces missing git tag history as a non-zero pm-cli error", async (t) => {
  // Depth-1/no-tags clone fixture: tag-derived flags must fail fast with the
  // structured E_MISSING_TAG_HISTORY diagnostic (pmc-yzho), carried by a
  // PmCliError whose exitCode is non-zero, instead of silently deriving an
  // incomplete release window.
  const sourceDir = mkdtempSync(join(tmpdir(), "pm-changelog-ext-shallow-src-"));
  const cloneParent = mkdtempSync(join(tmpdir(), "pm-changelog-ext-shallow-dst-"));
  t.after(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(cloneParent, { recursive: true, force: true });
  });
  execFileSync("git", ["init"], { cwd: sourceDir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: sourceDir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: sourceDir, encoding: "utf-8" });
  writeFileSync(join(sourceDir, "file.txt"), "one\n", "utf-8");
  execFileSync("git", ["add", "."], { cwd: sourceDir, encoding: "utf-8" });
  execFileSync("git", ["commit", "-m", "one"], { cwd: sourceDir, encoding: "utf-8" });
  execFileSync("git", ["tag", "v1.0.0"], { cwd: sourceDir, encoding: "utf-8" });
  const cloneDir = join(cloneParent, "clone");
  execFileSync("git", ["clone", "--depth", "1", "--no-tags", pathToFileURL(sourceDir).toString(), cloneDir], { encoding: "utf-8" });

  const { commands } = await activateChangelog();
  await assert.rejects(
    () => runRegisteredCommandForTest(commands, {
      command: "changelog generate",
      options: { "since-previous-tag": true },
      pmRoot: cloneDir,
    }),
    (error: unknown) => {
      assert.match((error as Error).message, /E_MISSING_TAG_HISTORY/);
      assert.match((error as Error).message, /git fetch --tags --unshallow/);
      assert.equal((error as { exitCode?: number }).exitCode, 1);
      return true;
    },
  );
});

test("changelog generate rejects unsupported --format values", async () => {
  const { commands } = await activateChangelog();
  await assert.rejects(
    () => runRegisteredCommandForTest(commands, {
      command: "changelog generate",
      options: { format: "js" },
      pmRoot: process.cwd(),
    }),
    /--format must be 'md' or 'json'/,
  );
});
