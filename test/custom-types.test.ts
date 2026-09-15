import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import extension from "../src/extension.ts";

test("generation and export enumerate configured custom types alongside built-ins", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-custom-types-"));
  const pmRoot = join(directory, ".agents", "pm");
  const cli = join(process.cwd(), "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  const env = { ...process.env, PM_PATH: pmRoot, PM_GLOBAL_PATH: join(directory, "global"), DO_NOT_TRACK: "1" };
  try {
    for (const args of [
      ["init", "--yes", "--agent-guidance", "skip"],
      ["schema", "add-type", "Story", "--folder", "stories"],
      ["create", "--title", "Custom story release", "--type", "Story", "--create-mode", "progressive"],
      ["create", "--title", "Built-in task release", "--type", "Task", "--create-mode", "progressive"],
    ]) {
      execFileSync(process.execPath, [cli, ...args], { cwd: directory, env, stdio: "pipe" });
    }
    const activation = await activateExtensionForTest(extension, {
      name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"],
    });
    assert.deepEqual(activation.failed, []);
    for (const command of ["changelog generate", "changelog export"]) {
      const { result } = await runRegisteredCommandForTest(activation.commands, {
        command, pmRoot, options: { stdout: true, status: "open", "explain-selection": true },
      });
      assert.ok(result !== null && typeof result === "object");
      assert.ok("item_count" in result);
      assert.equal(result.item_count, 2, command);
      assert.ok("changelog" in result && typeof result.changelog === "string");
      assert.match(result.changelog, /Custom story release/);
      assert.match(result.changelog, /Built-in task release/);
      if (command === "changelog generate") {
        assert.ok("selection_report" in result);
        const report = result.selection_report;
        assert.ok(report !== null && typeof report === "object" && "stage_counts" in report);
        const counts = report.stage_counts;
        assert.ok(counts !== null && typeof counts === "object" && "input" in counts);
        assert.equal(counts.input, 2);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
