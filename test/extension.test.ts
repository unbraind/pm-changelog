import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import extension from "../dist/extension.js";

test("extension command exposes item-url-base for clickable item IDs", () => {
  let registeredCommand: { flags?: Array<{ long?: string }> } | undefined;
  let registeredExporter: { flags?: Array<{ long?: string }>; examples?: string[] } | undefined;
  const rendererOwnership: Array<{
    format: string;
    ownership?: {
      commands?: string[];
      resultDiscriminator?: (result: unknown) => boolean;
    };
  }> = [];
  extension.activate({
    registerCommand(command: { flags?: Array<{ long?: string }> }) {
      registeredCommand = command;
    },
    registerExporter(_name: string, _handler: unknown, options?: { flags?: Array<{ long?: string }>; examples?: string[] }) {
      registeredExporter = options;
    },
    registerRenderer(
      format: string,
      _renderer: unknown,
      ownership?: {
        commands?: string[];
        resultDiscriminator?: (result: unknown) => boolean;
      },
    ) {
      rendererOwnership.push({ format, ownership });
    },
  } as unknown as Parameters<typeof extension.activate>[0]);
  assert.ok(registeredExporter, "extension should register the changelog exporter");
  assert.ok(
    registeredExporter.flags?.some((flag) => flag.long === "--format"),
    "changelog export should expose --format through pm contracts"
  );
  assert.ok(
    registeredExporter.flags?.some((flag) => flag.long === "--release-notes"),
    "changelog export should expose release-notes mode through pm contracts"
  );
  assert.ok(
    registeredExporter.examples?.some((example) => example.includes("changelog export --format json")),
    "changelog export should document json export usage"
  );

  assert.ok(registeredCommand, "extension should register the changelog command");
  assert.ok(
    registeredCommand.flags?.some((flag) => flag.long === "--item-url-base"),
    "changelog generate should expose --item-url-base through pm contracts"
  );
  assert.ok(
    registeredCommand.flags?.some((flag) => flag.long === "--release-version-from-package"),
    "changelog generate should expose package-version release mode through pm contracts"
  );
  assert.ok(
    registeredCommand.flags?.some((flag) => flag.long === "--since-previous-tag"),
    "changelog generate should expose previous-tag release range through pm contracts"
  );
  assert.ok(
    registeredCommand.flags?.some((flag) => flag.long === "--until-release-tag"),
    "changelog generate should expose release-tag cap through pm contracts"
  );
  assert.ok(
    registeredCommand.flags?.some((flag) => flag.long === "--all-release-tags"),
    "changelog generate should expose full git-tag history mode through pm contracts"
  );
  assert.ok(
    registeredCommand.flags?.some((flag) => flag.long === "--release-tag-pattern"),
    "changelog generate should expose full-history tag glob configuration through pm contracts"
  );
  for (const flag of ["--section-by", "--conventional", "--contributors", "--limit", "--since-version", "--include-metadata", "--changelog-json", "--explain", "--summary", "--format"]) {
    assert.ok(
      registeredCommand.flags?.some((f) => f.long === flag),
      `changelog generate should expose ${flag} through pm contracts`
    );
  }
  assert.deepEqual(
    rendererOwnership.map(({ format, ownership }) => ({
      format,
      commands: ownership?.commands,
    })),
    [
      {
        format: "toon",
        commands: ["changelog generate", "changelog export"],
      },
      {
        format: "json",
        commands: ["changelog generate", "changelog export"],
      },
    ],
  );
  for (const registration of rendererOwnership) {
    assert.equal(
      registration.ownership?.resultDiscriminator?.({
        pmChangelogRendered: true,
        output: "{}\n",
      }),
      true,
    );
    assert.equal(
      registration.ownership?.resultDiscriminator?.({ output: "{}\n" }),
      false,
    );
  }
});

test("changelog exporter rejects unsupported formats", async () => {
  let exporter: ((ctx: { options: Record<string, unknown>; pm_root: string }) => Promise<unknown>) | undefined;
  extension.activate({
    registerCommand() {},
    registerExporter(_name: string, handler: typeof exporter) {
      exporter = handler;
    },
  } as unknown as Parameters<typeof extension.activate>[0]);

  assert.ok(exporter, "extension should register the changelog exporter");
  await assert.rejects(
    () => exporter!({ options: { format: "js" }, pm_root: process.cwd() }),
    /--format must be 'md' or 'json'/,
  );
});

test("changelog generate rejects unsupported formats before workspace reads", async () => {
  let command: { run?: (ctx: { options: Record<string, unknown>; pm_root: string }) => Promise<unknown> } | undefined;
  extension.activate({
    registerCommand(registered: typeof command) {
      command = registered;
    },
    registerExporter() {},
  } as unknown as Parameters<typeof extension.activate>[0]);

  assert.ok(command?.run, "extension should register changelog generate");
  await assert.rejects(
    () => command!.run!({ options: { format: "jsn" }, pm_root: "/path/that/does/not/exist" }),
    /--format must be 'md' or 'json'/,
  );
});

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

  let command: { run?: (ctx: { options: Record<string, unknown>; pm_root: string }) => Promise<unknown> } | undefined;
  extension.activate({
    registerCommand(registered: typeof command) {
      command = registered;
    },
    registerExporter() {},
  } as unknown as Parameters<typeof extension.activate>[0]);

  assert.ok(command?.run, "extension should register changelog generate");
  await assert.rejects(
    () => command!.run!({ options: { "since-previous-tag": true }, pm_root: cloneDir }),
    (error: unknown) => {
      assert.match((error as Error).message, /E_MISSING_TAG_HISTORY/);
      assert.match((error as Error).message, /git fetch --tags --unshallow/);
      assert.equal((error as { exitCode?: number }).exitCode, 1);
      return true;
    },
  );
});

test("changelog generate rejects unsupported --format values", async () => {
  let handler: ((ctx: { options: Record<string, unknown>; pm_root: string }) => Promise<unknown>) | undefined;
  extension.activate({
    registerCommand(command: { run?: typeof handler }) {
      handler = command.run;
    },
    registerExporter() {},
  } as unknown as Parameters<typeof extension.activate>[0]);

  assert.ok(handler, "extension should register the changelog generate command");
  await assert.rejects(
    () => handler!({ options: { format: "js" }, pm_root: process.cwd() }),
    /--format must be 'md' or 'json'/,
  );
});
