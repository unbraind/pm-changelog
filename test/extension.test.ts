import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import type { ExtensionActivationResult, ExtensionCapability, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";

import extension, { extensionTestSurface } from "../src/extension.ts";
import { MissingTagHistoryError } from "../src/release-context.ts";

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
const TRACKER_ROOT = join(process.cwd(), ".agents", "pm");

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

/** Returns the extension-owned payload from the SDK dispatch envelope. */
function commandResult(value: Awaited<ReturnType<typeof runRegisteredCommandForTest>>): unknown {
  return value.result;
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
      pmRoot: TRACKER_ROOT,
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

// The extension used to keep a `registerFlags("changelog export", …)` fallback
// for hosts whose `registerExporter` accepted only (name, handler). Measured
// against the declared peer floor (pm-cli 2026.7.28), `api.registerExporter.length`
// is 3, so the 3rd argument carries the flags through the registration options
// and the legacy `registerFlags` branch was dead code. That branch (and the
// hand-built `api` double that simulated a 2-argument host) was removed; this
// test now pins that the exporter flags arrive via the options object on the
// real loader instead of a separate `registerFlags` call.
test("changelog exporter flags arrive via registerExporter options on the real host", async () => {
  const activation = await activateChangelog();

  // `registerExporter(name, handler, options)` surfaces its `options.flags` on
  // the auto-created "<name> export" command path exactly like `registerCommand`.
  const exportFlagEntry = activation.registrations.flags.find(
    (entry) => entry.target_command === "changelog export",
  );
  assert.ok(exportFlagEntry, "changelog export flags should be registered via exporter options");
  const exportLongs = exportFlagEntry.flags.map((flag) => flag.long);
  assert.ok(
    exportLongs.includes("--format"),
    "exporter options should surface --format on changelog export",
  );
  assert.ok(
    exportLongs.includes("--release-notes"),
    "exporter options should surface --release-notes on changelog export",
  );

  // The exporter registers exactly one command path; no separate `registerFlags`
  // entry should exist for a second registration of the same flags. Every
  // registered flag target is a distinct command path.
  const flagTargets = activation.registrations.flags.map((entry) => entry.target_command);
  const exportTargetCount = flagTargets.filter((target) => target === "changelog export").length;
  assert.equal(
    exportTargetCount,
    1,
    "changelog export flags should be registered exactly once (via exporter options), not duplicated through registerFlags",
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
      pmRoot: TRACKER_ROOT,
    }),
    /--format must be 'md' or 'json'/,
  );
});

test("extension option helpers validate every supported representation", () => {
  assert.equal(extensionTestSurface.stringOption({ "some-key": "kebab" }, "some-key", "someKey"), "kebab");
  assert.equal(extensionTestSurface.stringOption({ someKey: "camel" }, "some-key", "someKey"), "camel");
  assert.equal(extensionTestSurface.stringOption({ someKey: 3 }, "some-key", "someKey"), undefined);
  assert.equal(extensionTestSurface.booleanOption({ someKey: true }, "some-key", "someKey"), true);
  assert.equal(extensionTestSurface.booleanOption({}, "some-key", "someKey"), false);
  assert.equal(extensionTestSurface.itemRefStyleOption({}), undefined);
  assert.equal(extensionTestSurface.itemRefStyleOption({ itemRefStyle: " GITHUB " }), "github");
  assert.throws(() => extensionTestSurface.itemRefStyleOption({ "item-ref-style": "invalid" }), /item-ref-style/);
  assert.equal(extensionTestSurface.excludeTagsOption({}), undefined);
  assert.equal(extensionTestSurface.excludeTagsOption({ "exclude-tag": null }), undefined);
  assert.equal(extensionTestSurface.excludeTagsOption({ excludeTags: [" one,two ", ""] })?.join(","), "one,two");
  assert.equal(extensionTestSurface.excludeTagsOption({ excludeTag: " , " }), undefined);
  assert.equal(extensionTestSurface.parseLimitOption({}), undefined);
  assert.equal(extensionTestSurface.parseLimitOption({ limit: 2 }), 2);
  assert.equal(extensionTestSurface.parseLimitOption({ limit: "3" }), 3);
  assert.throws(() => extensionTestSurface.parseLimitOption({ limit: 0 }), /positive integer/);
  assert.throws(() => extensionTestSurface.parseLimitOption({ limit: 1.5 }), /positive integer/);
  assert.equal(extensionTestSurface.parseBodyPreviewOption({ bodyPreview: "4" }), 4);
  assert.equal(extensionTestSurface.parseBodyPreviewOption({ "body-preview": 5 }), 5);
  assert.equal(extensionTestSurface.parseBodyPreviewOption({ "body-preview": "" }), undefined);
  assert.throws(() => extensionTestSurface.parseBodyPreviewOption({ bodyPreview: -1 }), /positive integer/);
});

test("rendered result helpers own only valid JSON markers", () => {
  const rendered = extensionTestSurface.renderedCommandResult({ value: 1 });
  assert.equal(extensionTestSurface.isRenderedCommandResult(rendered), true);
  assert.equal(extensionTestSurface.renderCommandResult({ result: rendered }), '{\n  "value": 1\n}\n');
  assert.equal(extensionTestSurface.renderCommandResult(undefined), null);
  assert.equal(extensionTestSurface.isRenderedCommandResult(null), false);
  assert.equal(extensionTestSurface.isRenderedCommandResult({ pmChangelogRendered: false, output: "{}" }), false);
  assert.equal(extensionTestSurface.isRenderedCommandResult({ pmChangelogRendered: true, output: 1 }), false);
  assert.throws(() => extensionTestSurface.renderedCommandResult(undefined), /not JSON-serializable/);
});

test("tag-history diagnostics preserve ordinary errors and structure missing-history errors", () => {
  assert.equal(extensionTestSurface.withTagHistoryDiagnostics(() => "ok"), "ok");
  assert.throws(
    () => extensionTestSurface.withTagHistoryDiagnostics(() => {
      throw new Error("ordinary");
    }),
    /ordinary/,
  );
  assert.throws(
    () => extensionTestSurface.withTagHistoryDiagnostics(() => {
      throw new MissingTagHistoryError("missing tags");
    }),
    (error: unknown) => {
      assert.equal((error as Error).message, "missing tags");
      assert.equal((error as { exitCode?: number }).exitCode, 1);
      return true;
    },
  );
});

test("generate command exercises validation and every result mode through the real SDK host", async (t) => {
  const { commands } = await activateChangelog();
  for (const [key, value, pattern] of [
    ["group-by", "bad", /--group-by/],
    ["mode", "bad", /--mode/],
    ["section-by", "bad", /--section-by/],
  ] as const) {
    await assert.rejects(
      () => runRegisteredCommandForTest(commands, {
        command: "changelog generate",
        options: { [key]: value },
        pmRoot: TRACKER_ROOT,
      }),
      pattern,
    );
  }

  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-extension-modes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "CHANGELOG.md");
  const baseOptions = {
    status: "open,in_progress,closed,done",
    "release-version": "2026.8.7",
    date: "2026-08-07",
    explain: true,
  };
  const summaryJson = await runRegisteredCommandForTest(commands, {
    command: "changelog generate",
    options: { ...baseOptions, summary: true, format: "json" },
    pmRoot: TRACKER_ROOT,
  });
  assert.equal(extensionTestSurface.isRenderedCommandResult(commandResult(summaryJson)), true);
  const summaryJsonWithoutExplain = await runRegisteredCommandForTest(commands, {
    command: "changelog generate",
    options: { ...baseOptions, explain: false, summary: true, format: "json" },
    pmRoot: TRACKER_ROOT,
  });
  assert.equal(extensionTestSurface.isRenderedCommandResult(commandResult(summaryJsonWithoutExplain)), true);
  const summaryText = await runRegisteredCommandForTest(commands, {
    command: "changelog generate",
    options: { ...baseOptions, summary: true },
    pmRoot: TRACKER_ROOT,
  });
  assert.equal((commandResult(summaryText) as { format?: string }).format, "text");
  const populatedSummary = await runRegisteredCommandForTest(commands, {
    command: "changelog generate",
    options: { summary: true, status: "open,in_progress,closed" },
    pmRoot: TRACKER_ROOT,
  });
  assert.match((commandResult(populatedSummary) as { summary: string }).summary, /pmc-/);
  await runRegisteredCommandForTest(commands, {
    command: "changelog generate",
    options: { ...baseOptions, explain: false, summary: true },
    pmRoot: TRACKER_ROOT,
  });
  const document = await runRegisteredCommandForTest(commands, {
    command: "changelog generate",
    options: { ...baseOptions, "changelog-json": true },
    pmRoot: TRACKER_ROOT,
  });
  assert.equal(extensionTestSurface.isRenderedCommandResult(commandResult(document)), true);
  await runRegisteredCommandForTest(commands, {
    command: "changelog generate",
    options: { ...baseOptions, explain: false, "changelog-json": true },
    pmRoot: TRACKER_ROOT,
  });
  const semver = await runRegisteredCommandForTest(commands, {
    command: "changelog generate",
    options: { ...baseOptions, "suggest-semver": true, format: "json" },
    pmRoot: TRACKER_ROOT,
  });
  assert.equal(extensionTestSurface.isRenderedCommandResult(commandResult(semver)), true);
  await runRegisteredCommandForTest(commands, {
    command: "changelog generate",
    options: { ...baseOptions, explain: false, "suggest-semver": true },
    pmRoot: TRACKER_ROOT,
  });
  const stdout = await runRegisteredCommandForTest(commands, {
    command: "changelog generate",
    options: { ...baseOptions, stdout: true, mode: "prepend" },
    pmRoot: TRACKER_ROOT,
  });
  assert.equal(typeof (commandResult(stdout) as { changelog?: unknown }).changelog, "string");
  const written = await runRegisteredCommandForTest(commands, {
    command: "changelog generate",
    options: { ...baseOptions, output },
    pmRoot: TRACKER_ROOT,
  });
  assert.equal((commandResult(written) as { changed?: boolean }).changed, true);
  await runRegisteredCommandForTest(commands, {
    command: "changelog generate",
    options: { ...baseOptions, explain: false, output },
    pmRoot: TRACKER_ROOT,
  });
  await assert.rejects(
    () => runRegisteredCommandForTest(commands, {
      command: "changelog generate",
      options: { ...baseOptions, output, check: true, title: "Changed title" },
      pmRoot: TRACKER_ROOT,
    }),
    /out of date/,
  );
});

test("generate all-tag and body-preview paths use the real tracker", async () => {
  const { commands } = await activateChangelog();
  const result = await runRegisteredCommandForTest(commands, {
    command: "changelog generate",
    options: {
      stdout: true,
      "all-release-tags": true,
      "release-version": "2026.8.8",
      "body-preview": 8,
      "release-tag-pattern": "v*",
    },
    pmRoot: TRACKER_ROOT,
  });
  assert.equal(typeof (commandResult(result) as { changelog?: unknown }).changelog, "string");
  const items = [
    { id: "missing-item", title: "missing" },
    { title: "no id" },
    { id: "already", title: "already", body: "present" },
    { id: "pmc-2sfc", title: "tracker with body" },
  ];
  await extensionTestSurface.enrichItemBodies(TRACKER_ROOT, items);
  assert.equal(items[2]?.body, "present");
  assert.equal(typeof items[3]?.body, "string");
  await extensionTestSurface.enrichItemBodies(TRACKER_ROOT, items, {
    ...extensionTestSurface.bodyEnrichmentDependencies,
    readSettings: async () => {
      throw new Error("settings failed");
    },
  });
  await extensionTestSurface.enrichItemBodies(TRACKER_ROOT, [{ id: "broken", title: "broken" }], {
    ...extensionTestSurface.bodyEnrichmentDependencies,
    locateItem: async () => {
      throw new Error("locate failed");
    },
  });
  const emptyBodyItems = [{ id: "pmc-2sfc", title: "empty body" }];
  await extensionTestSurface.enrichItemBodies(TRACKER_ROOT, emptyBodyItems, {
    ...extensionTestSurface.bodyEnrichmentDependencies,
    readLocatedItem: async (located, options) => {
      const loaded = await extensionTestSurface.bodyEnrichmentDependencies.readLocatedItem(located, options);
      return { ...loaded, document: { ...loaded.document, body: "" } };
    },
  });
  assert.equal("body" in emptyBodyItems[0], false);
});

test("exporter exercises validation, JSON, markdown, stdout, and file modes", async (t) => {
  const { commands } = await activateChangelog();
  await assert.rejects(
    () => runRegisteredCommandForTest(commands, {
      command: "changelog export",
      options: { "group-by": "bad" },
      pmRoot: TRACKER_ROOT,
    }),
    /--group-by/,
  );
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-export-modes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const jsonPath = join(directory, "notes.json");
  const markdownPath = join(directory, "notes.md");
  const baseOptions = {
    status: "closed,done",
    "release-version": "2026.8.7",
    date: "2026-08-07",
    "release-notes": true,
    "include-metadata": true,
  };
  const json = await runRegisteredCommandForTest(commands, {
    command: "changelog export",
    options: { ...baseOptions, format: "json" },
    pmRoot: TRACKER_ROOT,
  });
  assert.equal(extensionTestSurface.isRenderedCommandResult(commandResult(json)), true);
  const jsonFile = await runRegisteredCommandForTest(commands, {
    command: "changelog export",
    options: { ...baseOptions, format: "json", output: jsonPath },
    pmRoot: TRACKER_ROOT,
  });
  assert.equal((commandResult(jsonFile) as { format?: string }).format, "json");
  assert.match(readFileSync(jsonPath, "utf-8"), /"markdown"/);
  const markdown = await runRegisteredCommandForTest(commands, {
    command: "changelog export",
    options: baseOptions,
    pmRoot: TRACKER_ROOT,
  });
  assert.equal((commandResult(markdown) as { format?: string }).format, "markdown");
  const markdownFile = await runRegisteredCommandForTest(commands, {
    command: "changelog export",
    options: { ...baseOptions, output: markdownPath },
    pmRoot: TRACKER_ROOT,
  });
  assert.equal((commandResult(markdownFile) as { format?: string }).format, "markdown");
  assert.match(readFileSync(markdownPath, "utf-8"), /Release Notes/);
  const defaults = await runRegisteredCommandForTest(commands, {
    command: "changelog export",
    options: { format: "json" },
    pmRoot: TRACKER_ROOT,
  });
  const defaultPayload = commandResult(defaults);
  assert.equal(extensionTestSurface.isRenderedCommandResult(defaultPayload), true);
  assert.match((defaultPayload as { output: string }).output, /"version": "Unreleased"/);
  const defaultMarkdown = await runRegisteredCommandForTest(commands, {
    command: "changelog export",
    options: {},
    pmRoot: TRACKER_ROOT,
  });
  assert.equal((commandResult(defaultMarkdown) as { format?: string }).format, "markdown");
});
