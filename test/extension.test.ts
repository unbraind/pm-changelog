import assert from "node:assert/strict";
import test from "node:test";

import extension from "../dist/extension.js";

test("extension command exposes item-url-base for clickable item IDs", () => {
  let registeredCommand: { flags?: Array<{ long?: string }> } | undefined;
  let registeredExporter: { flags?: Array<{ long?: string }>; examples?: string[] } | undefined;
  extension.activate({
    registerCommand(command: { flags?: Array<{ long?: string }> }) {
      registeredCommand = command;
    },
    registerExporter(_name: string, _handler: unknown, options?: { flags?: Array<{ long?: string }>; examples?: string[] }) {
      registeredExporter = options;
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
  for (const flag of ["--section-by", "--conventional", "--contributors", "--limit", "--since-version", "--include-metadata", "--changelog-json", "--explain"]) {
    assert.ok(
      registeredCommand.flags?.some((f) => f.long === flag),
      `changelog generate should expose ${flag} through pm contracts`
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
