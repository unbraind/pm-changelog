import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runInit, runCreate } from "@unbrained/pm-cli/sdk";
import { createChangelog, createReleaseMilestone, DirectoryReleaseMilestoneStore, readTrackerReleaseSnapshot, resolveTrackerReleaseHistory } from "../dist/index.js";

const root = mkdtempSync(join(tmpdir(), "pm-bun-milestones-"));
const pmRoot = join(root, ".agents", "pm");
try {
  await runInit("pm", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  await runCreate({ id: "smoke-delivered", title: "Bun milestone delivery", type: "Task", status: "closed", closeReason: "Delivered", createMode: "progressive" }, { path: pmRoot });
  const milestone = await createReleaseMilestone(new DirectoryReleaseMilestoneStore(pmRoot), "bun-release", await readTrackerReleaseSnapshot(pmRoot));
  const sdk = createChangelog(resolveTrackerReleaseHistory([milestone], []));
  assert.equal(sdk.itemCount, 1);
  assert.match(sdk.markdown, /Bun milestone delivery/);
  const noGit = join(root, "bin");
  mkdirSync(noGit);
  symlinkSync(process.execPath, join(noGit, "node"));
  const cli = spawnSync(process.execPath, [resolve("dist/cli.js"), "--milestones", "--pm-root", pmRoot, "--stdout"], {
    cwd: root, encoding: "utf8", env: { ...process.env, PATH: noGit, GIT_CEILING_DIRECTORIES: dirname(root), DO_NOT_TRACK: "1" },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, sdk.markdown);
  console.log("Direct Bun runtime: CLI and SDK passed (2/2), plain tracker without git on PATH.");
} finally { rmSync(root, { recursive: true, force: true }); }
