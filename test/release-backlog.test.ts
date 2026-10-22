import { initGitFixture, removeGitFixture } from "./git-fixture.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runCreate } from "@unbrained/pm-cli/sdk";

/** Return one release body, stopping before the next level-two heading. */
function releaseSection(markdown: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = markdown.split("\n").indexOf(marker);
  assert.notEqual(start, -1, `Missing release heading: ${heading}`);
  const lines = markdown.split("\n").slice(start + 1);
  const end = lines.findIndex((line) => line.startsWith("## "));
  return lines.slice(0, end === -1 ? undefined : end).join("\n");
}

test("self-generation scripts preserve a same-day suffix and check the version date in a real tracker", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-changelog-backlog-"));
  t.after(() => removeGitFixture(cwd));
  const pmRoot = join(cwd, ".agents", "pm");
  const env = { ...process.env, PM_PATH: pmRoot, PM_GLOBAL_PATH: join(cwd, "global"), PM_AUTHOR: "test-agent", PM_TELEMETRY_DISABLED: "1", GITHUB_STEP_SUMMARY: join(cwd, "summary.md") };
  const cli = resolve("dist/cli.js");
  const pmCli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const initialized = spawnSync(process.execPath, [pmCli, "init", "--yes", "--agent-guidance", "skip"], { cwd, env, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  initGitFixture(cwd, ["--quiet"]);
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "release-fixture", version: "2001.2.3-2" }));
  const created = await runCreate({ title: "Preserve the release date", type: "Issue", status: "closed", closeReason: "Keep the calendar day stable", createMode: "progressive" }, { path: pmRoot });
  assert.equal(typeof created.item.id, "string");
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

  // Execute the repository's actual script arguments, rebasing only executable
  // locations into the installed checkout. Removing its date flag must fail
  // this test, even if README examples and the parser still carry the flag.
  for (const script of ["changelog:full", "release:notes"]) {
    const [runtime, entry, ...args] = manifest.scripts[script].split(/\s+/);
    assert.equal(runtime, "node");
    const executable = script === "changelog:full" ? resolve(entry) : cli;
    if (script === "changelog:full") {
      assert.equal(entry, "scripts/project-changelog.ts");
      args.push("--pm-bin", resolve("node_modules/.bin/pm"));
    } else {
      assert.equal(entry, "dist/cli.js");
      const pmBinIndex = args.indexOf("--pm-bin");
      assert.notEqual(pmBinIndex, -1);
      args[pmBinIndex + 1] = resolve("node_modules/.bin/pm");
    }
    const generated = spawnSync(process.execPath, [executable, ...args], { cwd, env, encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    const markdown = script === "changelog:full" ? readFileSync(join(cwd, "CHANGELOG.md"), "utf8") : generated.stdout;
    assert.match(markdown, /^## 2001\.2\.3-2 - 2001-02-03$/m);
    assert.ok(releaseSection(markdown, "2001.2.3-2 - 2001-02-03").includes(String(created.item.id)), "issue must occur inside the expected release section");
    if (script === "changelog:full") {
      const checked = spawnSync(process.execPath, [executable, ...args, "--check", "--check-links"], { cwd, env, encoding: "utf8" });
      assert.equal(checked.status, 0, checked.stderr);
    }
  }
});
