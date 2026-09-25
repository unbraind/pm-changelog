import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import { runCreate, runWithActiveExtensions } from "@unbrained/pm-cli/sdk";
import extension from "../src/extension.ts";

test("generation and export enumerate configured and extension types alongside built-ins", async () => {
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
    const extensionRoot = join(pmRoot, "extensions", "release-types");
    mkdirSync(extensionRoot, { recursive: true });
    writeFileSync(join(extensionRoot, "manifest.json"), JSON.stringify({ name: "release-types", version: "1.0.0", entry: "./index.mjs", capabilities: ["schema"] }));
    writeFileSync(join(extensionRoot, "index.mjs"), "export function activate(api) { api.registerItemTypes([{ name: 'Changeset', folder: 'changesets' }]); }");
    await runWithActiveExtensions({ path: pmRoot }, async () => {
      await runCreate({ title: "Extension changeset release", type: "Changeset", createMode: "progressive", body: "Actual extension body evidence" }, { path: pmRoot });
      await runCreate({ title: "Closed extension delivery", type: "Changeset", createMode: "progressive", status: "closed", closeReason: "Fixture accepted", completedAt: "2026-09-25T00:00:00.000Z" }, { path: pmRoot });
      const activation = await activateExtensionForTest(extension, {
        name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"],
      });
      assert.deepEqual(activation.failed, []);
      for (const command of ["changelog generate", "changelog export"]) {
        const defaultRun = await runRegisteredCommandForTest(activation.commands, { command, pmRoot, options: { stdout: true } });
        assert.ok(defaultRun.result !== null && typeof defaultRun.result === "object");
        assert.ok("item_count" in defaultRun.result && defaultRun.result.item_count === 1);
        assert.ok("changelog" in defaultRun.result && typeof defaultRun.result.changelog === "string");
        assert.match(defaultRun.result.changelog, /Closed extension delivery/);
        assert.doesNotMatch(defaultRun.result.changelog, /Custom story release|Built-in task release|Extension changeset release/);
        const { result } = await runRegisteredCommandForTest(activation.commands, {
          command, pmRoot, options: { stdout: true, status: "open", "explain-selection": true, "body-preview": 100 },
        });
        assert.ok(result !== null && typeof result === "object");
        assert.ok("item_count" in result);
        assert.equal(result.item_count, 3, command);
        assert.ok("changelog" in result && typeof result.changelog === "string");
        assert.match(result.changelog, /Custom story release/);
        assert.match(result.changelog, /Built-in task release/);
        assert.match(result.changelog, /Extension changeset release/);
        if (command === "changelog generate") assert.match(result.changelog, /Actual extension body evidence/);
        if (command === "changelog generate") {
          assert.ok("selection_report" in result);
          const report = result.selection_report;
          assert.ok(report !== null && typeof report === "object" && "stage_counts" in report);
          const counts = report.stage_counts;
          assert.ok(counts !== null && typeof counts === "object" && "input" in counts);
          assert.equal(counts.input, 4);
        }
      }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
