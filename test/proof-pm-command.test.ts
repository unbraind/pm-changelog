import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listAllComplete, runCreate, runInit } from "@unbrained/pm-cli/sdk";
import { runProofPm } from "../scripts/proof-pm-command.ts";
import { fixtureEnvironment } from "./git-fixture.ts";

test("proof PM mutations use Node without a shell shim or a node executable on PATH", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-proof-command-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const pmRoot = join(cwd, ".agents/pm");
  await runInit("proof", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  await runCreate({ id: "proof-item", title: "Original title", type: "Task", createMode: "progressive" }, { path: pmRoot });
  for (const [path, title] of [["", "Updated without node on PATH"], [process.env.PATH, "Updated with normal PATH"]]) {
    const result = runProofPm(["--path", pmRoot, "update", "proof-item", "--title", title!], {
      cwd, encoding: "utf8", env: { ...fixtureEnvironment(), PATH: path, PM_AUTHOR: "codex-agent", PM_TELEMETRY_SOURCE_CONTEXT: "automation", DO_NOT_TRACK: "1" },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? ""));
    assert.equal((await listAllComplete({}, { pmRoot })).items.find((item) => item.id === "proof-item")!.title, title);
  }
});
