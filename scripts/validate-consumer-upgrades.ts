import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";
import { buildAudienceContracts, formatConsumerUpgrades, readConsumerUpgrades } from "../src/index.ts";

/** Sorted path/hash manifest detects both content and membership changes without writing. */
function manifest(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return `${path.slice(root.length + 1)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    }).sort();
}

const pmRoot = resolve(process.argv[2]);
const options = { audience: "operator" as const, from: "0.0.0", to: "2026.10.25" };
const before = manifest(pmRoot);
const items = (await listAllComplete({ includeBody: false }, { pmRoot })).items;
const contracts = buildAudienceContracts({ items, audience: "operator", groupBy: "release" });
const started = performance.now();
const report = await readConsumerUpgrades(pmRoot, options);
const elapsed = performance.now() - started;
const json = formatConsumerUpgrades(report, "json"), toon = formatConsumerUpgrades(report, "toon");
assert.deepEqual(decodeToon(toon), report);
const cli = spawnSync(process.execPath, [resolve("dist/cli.js"), "upgrades", "--pm-root", pmRoot,
  "--audience", options.audience, "--from", options.from, "--to", options.to, "--json"], { encoding: "utf8" });
assert.equal(cli.status, 0, cli.stderr);
assert.equal(cli.stdout, json);
assert.deepEqual(manifest(pmRoot), before);
console.log(JSON.stringify({ input_items: items.length, closed_items: items.filter((item) => item.status === "closed").length,
  selected_changes: contracts.item_count, release_groups: new Set(contracts.ledger.map((row) => row.release)).size,
  facet_declarations: items.reduce((count, item) => count + (Array.isArray(item.change_facets) ? item.change_facets.length : 0), 0),
  actions: report.action_count, omissions: report.omissions.length, satisfied_prerequisites: report.satisfied_prerequisites.length,
  json_bytes: Buffer.byteLength(json), toon_bytes: Buffer.byteLength(toon), warm_sdk_ms: Math.round(elapsed),
  unchanged_files: before.length, manifest_sha256: createHash("sha256").update(before.join("\n")).digest("hex"), sdk_cli_equal: true }, null, 2));
