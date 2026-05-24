import assert from "node:assert/strict";
import test from "node:test";

import extension from "../dist/extension.js";

test("extension command exposes item-url-base for clickable item IDs", () => {
  let registeredCommand: { flags?: Array<{ long?: string }> } | undefined;
  extension.activate({
    registerCommand(command: { flags?: Array<{ long?: string }> }) {
      registeredCommand = command;
    },
  } as Parameters<typeof extension.activate>[0]);

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
});
