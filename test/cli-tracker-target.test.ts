import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { runInit, runCreate, PmClient, schemaAddStatus } from "@unbrained/pm-cli/sdk";
import { decode } from "@toon-format/toon";

const unset = ["parent", "goal", "objective", "sprint", "release"];

test("every standalone projection follows forwarded tracker identity and SDK path aliases without git", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "pm-target-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const local = join(scratch, "local"), selected = join(scratch, "selected tracker");
  const a = join(local, ".agents/pm"), b = join(selected, ".agents/pm");
  await runInit("local", { path: a }, { defaults: true, agentGuidance: "skip" });
  await runInit("remote", { path: b }, { defaults: true, agentGuidance: "skip" });
  // Distinct random aliases and conflicting roles expose accidental ambient reads.
  let seed = 0x291f5;
  for (let index = 0; index < 3; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const status = `delivered_${seed}`;
    await schemaAddStatus(status, { role: ["active"] }, { pmRoot: a });
    await schemaAddStatus(status, { role: ["terminal", "terminal_done"] }, { pmRoot: b });
    for (const [suffix, reason] of [["repair", "Fixed recorded defect"], ["duplicate", "Duplicate"]]) {
      const id = `remote-${index}-${suffix}`;
      await runCreate({ id, title: id, type: "Issue", status: "open", createMode: "progressive", unset }, { path: b, author: "target-test" });
      await new PmClient({ pmRoot: b, author: "target-test" }).update(id, { status, closeReason: reason, unset });
    }
  }
  const emptyBin = join(scratch, "bin"); mkdirSync(emptyBin);
  const childEnv = { PATH: emptyBin, HOME: scratch, PM_AUTHOR: "target-test", PM_PATH: a, PM_GLOBAL_PATH: join(scratch, "global"), GIT_CEILING_DIRECTORIES: dirname(scratch), DO_NOT_TRACK: "1" };
  const path = relative(local, b);
  const selectors = [
    ["--pm-arg=--path", `--pm-arg=${path}`],
    [`--pm-arg=--path=${path}`],
    ["--pm-arg=--pm-path", `--pm-arg=${path}`],
    [`--pm-arg=--pm-path=${path}`],
    ["--pm-root", path],
    ["--pm-cwd", selected],
  ];
  // Explicit cwd lookup needs no ambient PM_PATH; forwarded selections must override it.
  for (const selector of selectors) {
    const run = (args: string[]): string => {
      const result = spawnSync(process.execPath, [resolve("dist/cli.js"), ...selector, ...args], { cwd: local, env: { ...childEnv, ...(selector[0] === "--pm-cwd" ? { PM_PATH: "" } : {}) }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr); return result.stdout;
    };
    const doc = JSON.parse(run(["--changelog-json", "--explain"]));
    assert.equal(doc.item_count, 3); assert.equal(doc.excluded_non_change_count, 3);
    assert.equal(JSON.parse(run(["--summary", "--format", "json"])).entries.length, 3);
    assert.equal(JSON.parse(run(["--suggest-semver", "--json"])).counts.fix, 3);
    for (const format of ["json", "toon"]) {
      const output = run(["--audit-evidence", ...(format === "json" ? ["--json"] : [])]);
      const audit = format === "json" ? JSON.parse(output) : decode(output);
      assert.equal(audit.claims.length, 3);
    }
    const markdown = run(["--stdout", "--check-links", "--item-url-base", "https://example.com/items"]);
    assert.match(markdown, /remote-0-repair/); assert.doesNotMatch(markdown, /remote-0-duplicate/);
  }
});
