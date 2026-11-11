import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { listAllComplete, runCreate, runInit } from "@unbrained/pm-cli/sdk";
import { attributeRenderingRelease } from "../scripts/attribute-rendering-release.ts";
import { buildConsumerUpgrades } from "../src/consumer-upgrades.ts";

test("selected release attributes only delivered pending rendering actions with native history", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-rendering-release-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const pmRoot = join(cwd, ".agents/pm");
  await runInit("release", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  for (const [id, status, release, tags] of [["release-pending", "closed", undefined, "rendering-change"], ["release-active", "in_progress", undefined, "rendering-change"], ["release-existing", "closed", "1.0.0", "rendering-change"], ["release-untagged", "closed", undefined, ""]]) {
    await runCreate({ id, status, release, tags, title: `Delivered ${id}`, type: "Task", createMode: "progressive", closeReason: status === "closed" ? "Implemented the change" : undefined }, { path: pmRoot });
  }
  const history = join(pmRoot, "history/release-pending.jsonl");
  const before = readFileSync(history);
  await assert.rejects(() => attributeRenderingRelease(pmRoot, ""), /selected stable delivery version/);
  assert.deepEqual(await attributeRenderingRelease(pmRoot, "2.0.0"), ["release-pending"]);
  const after = readFileSync(history);
  assert.ok(after.subarray(0, before.length).equals(before));
  assert.ok(after.length > before.length);
  assert.deepEqual(await attributeRenderingRelease(pmRoot, "2.0.0"), []);
  assert.deepEqual(readFileSync(history), after);
  const rows = (await listAllComplete({}, { pmRoot })).items;
  assert.equal(rows.find((item) => item.id === "release-pending")!.release, "2.0.0");
  assert.equal(rows.find((item) => item.id === "release-active")!.release, undefined);
  const workflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /node scripts\/attribute-rendering-release\.ts "\$\{NPM_VERSION\}"/);
  assert.match(workflow, /git add[^\n]+CHANGELOG\.md \.agents\/pm/);
});

test("blank legacy releases remain unpublished in real tracker projections with metadata fallback", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-blank-release-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const pmRoot = join(cwd, ".agents/pm");
  await runInit("release", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  await runCreate({ id: "release-item", title: "Delivered release change", type: "Task", status: "closed", closeReason: "Implemented change", createMode: "progressive" }, { path: pmRoot });
  const item = (await listAllComplete({}, { pmRoot })).items[0]!;
  const change_facets = [{ audience: "operator" as const, text: "Regenerate once", breaking: true as const, upgrade_actions: [{ id: "regenerate", title: "Regenerate once", requires: [] }] }];
  for (const release of [undefined, "", " ", "\t\r\n", "\u2003"]) {
    assert.doesNotThrow(() => {
      const report = buildConsumerUpgrades({ audience: "operator", from: "1.0.0", to: "2.0.0", items: [{ ...item, release, change_facets }] });
      assert.equal(report.action_count, 0);
    });
    const fallback = buildConsumerUpgrades({ audience: "operator", from: "1.0.0", to: "2.0.0", items: [{ ...item, release, metadata: { release: " 2.0.0 " }, change_facets }] });
    assert.equal(fallback.action_count, 1);
  }
});
